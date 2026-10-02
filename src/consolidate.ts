import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryConfig } from "./config.js";
import { applyDecayAndPrune } from "./usage.js";
import { dedupCheck, secretScan } from "./tools.js";
import type { MarkdownStore, MemoryScope, MemoryType } from "./store.js";

// ---------- ops ----------

export type MemoryOp =
  | { op: "ADD"; type: MemoryType; title: string; body: string; scope: MemoryScope; confidence: number }
  | { op: "UPDATE"; targetId: string; title?: string; body: string; reason?: string }
  | { op: "DELETE"; targetId: string; reason?: string }
  | { op: "NOOP" };

function isValidOp(x: unknown): x is MemoryOp {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  switch (o.op) {
    case "ADD":
      return (
        (o.type === "decision" || o.type === "fact" || o.type === "lesson" || o.type === "snapshot") &&
        typeof o.title === "string" &&
        typeof o.body === "string" &&
        (o.scope === "project" || o.scope === "global") &&
        typeof o.confidence === "number" && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1
      );
    case "UPDATE":
      return typeof o.targetId === "string" && typeof o.body === "string" &&
        (o.title === undefined || typeof o.title === "string") &&
        (o.reason === undefined || typeof o.reason === "string");
    case "DELETE":
      return typeof o.targetId === "string" && (o.reason === undefined || typeof o.reason === "string");
    case "NOOP":
      return true;
    default:
      return false;
  }
}

function parseExtraction(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

export function parseOps(raw: string, maxOps: number): MemoryOp[] {
  return (parseExtraction(raw) ?? []).filter(isValidOp).slice(0, maxOps);
}

// ---------- transcript ----------

export interface SessionEntryLike {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown; toolName?: string };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "toolCall" && typeof b.name === "string") parts.push(`[called tool ${b.name}]`);
    }
  }
  return parts.join("\n");
}

function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[truncated]…\n${s.slice(-half)}`;
}

export function transcriptFromEntries(
  entries: SessionEntryLike[],
  lastEntryId: string | null,
  maxChars: number,
): { text: string; lastId: string | null } {
  // Stale watermark (e.g. /tree navigation changed the branch): process a bounded
  // tail of the last 200 entries instead of getting stuck (spec §7.4).
  let fromIndex: number;
  if (lastEntryId === null) {
    fromIndex = 0;
  } else {
    const idx = entries.findIndex((e) => e.id === lastEntryId);
    fromIndex = idx >= 0 ? idx + 1 : Math.max(0, entries.length - 200);
  }
  const slice = entries.slice(fromIndex).filter((e) => e.type === "message" && e.message?.role);
  if (slice.length === 0) return { text: "", lastId: null };
  const sections: string[] = [];
  for (const e of slice) {
    const role = e.message!.role;
    if (role === "user") sections.push(`## USER\n${blockText(e.message!.content)}`);
    else if (role === "assistant") sections.push(`## ASSISTANT\n${blockText(e.message!.content)}`);
    else if (role === "toolResult") {
      const raw = blockText(e.message!.content);
      sections.push(`## TOOL ${e.message!.toolName ?? "?"}\n${raw.slice(0, 200)}`);
    }
  }
  return { text: truncateMiddle(sections.join("\n\n"), maxChars), lastId: slice[slice.length - 1]!.id };
}

// ---------- prompt ----------

export function buildExtractionPrompt(indexLines: string[], transcript: string): string {
  return [
    "You are the memory consolidator for a coding agent. Extract durable knowledge from the session transcript.",
    "",
    "Existing memories (do not duplicate these):",
    indexLines.length > 0 ? indexLines.join("\n") : "(none yet)",
    "",
    "Rules:",
    "- Extract only durable knowledge: project decisions (with the why), stable facts, lessons from mistakes.",
    "- Skip anything derivable from the codebase, task logs, or one-off details.",
    "- Prefer UPDATE over ADD when an existing memory is similar; merge duplicates.",
    "- Mark contradictions as UPDATE (the old value is wrong now) and give a reason.",
    "- DELETE only for memories that are clearly garbage or obsolete.",
    "- Max 12 ops, ordered by confidence.",
    "",
    'Return ONLY a JSON array. Op shapes:',
    '{"op":"ADD","type":"decision|fact|lesson","title":"one line","body":"2-6 sentences","scope":"project|global","confidence":0.0-1.0}',
    '{"op":"UPDATE","targetId":"mem-xxxxxxxx","title":"optional new title","body":"new body","reason":"why"}',
    '{"op":"DELETE","targetId":"mem-xxxxxxxx","reason":"why"}',
    '{"op":"NOOP"}',
    "",
    "## Session transcript",
    transcript,
  ].join("\n");
}

// ---------- apply ----------

export interface AppliedOps {
  added: string[];
  updated: string[];
  deleted: string[];
  skipped: number;
  notes: string[];
}

export async function applyOps(
  store: MarkdownStore,
  ops: MemoryOp[],
  cfg: { maxOpsPerRun: number },
  now: Date,
): Promise<AppliedOps> {
  return store.withMutation(() => applyOpsUnlocked(store, ops, cfg, now));
}

async function applyOpsUnlocked(
  store: MarkdownStore,
  ops: MemoryOp[],
  cfg: { maxOpsPerRun: number },
  now: Date,
): Promise<AppliedOps> {
  const result: AppliedOps = { added: [], updated: [], deleted: [], skipped: 0, notes: [] };
  for (const op of ops.slice(0, cfg.maxOpsPerRun)) {
    if (op.op === "NOOP") continue;
    if (op.op === "ADD") {
      if (op.type === "snapshot") {
        // The consolidation op schema carries no anchor/expiresAfter, so a snapshot
        // ADD could never satisfy the P2-7 requirement — refuse it here rather than
        // create a snapshot that never expires.
        result.skipped += 1;
        result.notes.push(`ADD "${op.title}" skipped: snapshot requires anchor+expiresAfter (use memory_save)`);
        continue;
      }
      if (op.confidence < 0.7) {
        result.skipped += 1;
        result.notes.push(`ADD "${op.title}" skipped: confidence ${op.confidence} < 0.7`);
        continue;
      }
      const scan = secretScan(`${op.title}\n${op.body}`);
      if (!scan.ok) {
        result.skipped += 1;
        result.notes.push(`ADD "${op.title}" ${scan.reason}`);
        continue;
      }
      const dup = await dedupCheck(store, op);
      if (dup) {
        result.skipped += 1;
        result.notes.push(`ADD "${op.title}" skipped: duplicates ${dup.id}`);
        continue;
      }
      const saved = await store.save(op);
      result.added.push(saved.id);
    } else if (op.op === "UPDATE") {
      const file = await store.get(op.targetId);
      if (!file) {
        result.skipped += 1;
        result.notes.push(`UPDATE ${op.targetId} skipped: not found`);
        continue;
      }
      const scan = secretScan(`${op.title ?? ""}\n${op.body}`);
      if (!scan.ok) {
        result.skipped += 1;
        result.notes.push(`UPDATE ${op.targetId} ${scan.reason}`);
        continue;
      }
      file.body = op.body;
      if (op.title !== undefined && op.title !== file.title) {
        file.previousTitles = [file.title, ...file.previousTitles].slice(0, 3);
        file.title = op.title;
      }
      file.revision += 1;
      file.lastUsed = now.toISOString(); // referenced as evidence counts as use
      await store.update(file);
      result.updated.push(file.id);
    } else if (op.op === "DELETE") {
      const ok = await store.moveToArchive(op.targetId, `consolidation DELETE: ${op.reason ?? "unspecified"}`);
      if (ok) result.deleted.push(op.targetId);
      else result.skipped += 1;
    }
  }
  return result;
}

// ---------- watermark ----------

export interface StateFile {
  sessionId: string | null;
  lastEntryId: string | null;
  lastConsolidatedAt: string | null;
}

const EMPTY_STATE: StateFile = { sessionId: null, lastEntryId: null, lastConsolidatedAt: null };

export class WatermarkStore {
  private path: string;
  constructor(scopeDir: string) {
    this.path = join(scopeDir, "state.json");
  }
  async read(): Promise<StateFile> {
    try {
      return { ...EMPTY_STATE, ...JSON.parse(await readFile(this.path, "utf8")) };
    } catch {
      return { ...EMPTY_STATE };
    }
  }
  async write(s: StateFile): Promise<void> {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}

// ---------- runner ----------

export type CompleteFn = (prompt: string) => Promise<string>;

export interface ConsolidationResult {
  ok: boolean;
  reason?: string;
  applied?: AppliedOps;
  pruned?: string[];
}

const TRANSCRIPT_MAX_CHARS = 30000;

export async function runConsolidation(
  store: MarkdownStore,
  entries: SessionEntryLike[],
  opts: { complete: CompleteFn; cfg: MemoryConfig; sessionId: string | null; now: Date; signal?: AbortSignal },
): Promise<ConsolidationResult> {
  if (opts.signal?.aborted) return { ok: false, reason: "memory consolidation aborted" };
  const wm = new WatermarkStore(store.scopeDir("project"));
  const state = await wm.read();

  const { text, lastId } = transcriptFromEntries(entries, state.lastEntryId, TRANSCRIPT_MAX_CHARS);

  if (text.length > 0) {
    const indexLines = [
      ...(await store.activeIndexLines("project")),
      ...(await store.activeIndexLines("global")),
    ];
    let raw: string;
    try {
      opts.signal?.throwIfAborted();
      raw = await opts.complete(buildExtractionPrompt(indexLines, text));
      opts.signal?.throwIfAborted();
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const extracted = parseExtraction(raw);
    if (extracted === null || !extracted.every(isValidOp)) {
      return { ok: false, reason: "invalid memory extraction: expected an array of valid operations" };
    }
    const ops = extracted.slice(0, opts.cfg.maxOpsPerRun);
    return store.withMutation(async () => {
      opts.signal?.throwIfAborted();
      // Once file mutation starts, finish the commit including its watermark.
      // Shutdown awaits this phase rather than leaving partially applied state.
      const applied = await applyOps(store, ops, { maxOpsPerRun: opts.cfg.maxOpsPerRun }, opts.now);
      const { pruned } = await applyDecayAndPrune(store, opts.cfg, opts.now);
      if (lastId !== null) {
        await wm.write({
          sessionId: opts.sessionId,
          lastEntryId: lastId,
          lastConsolidatedAt: opts.now.toISOString(),
        });
      }
      return { ok: true, applied, pruned };
    }, opts.signal);
  }

  // Nothing new: still run decay/prune, skip the LLM.
  return store.withMutation(async () => {
    opts.signal?.throwIfAborted();
    const { pruned } = await applyDecayAndPrune(store, opts.cfg, opts.now);
    return { ok: true, applied: { added: [], updated: [], deleted: [], skipped: 0, notes: [] }, pruned };
  }, opts.signal);
}
