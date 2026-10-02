import type { MemoryScope, MemoryStatus, MemoryType } from "./store.js";
import { MarkdownStore, effectiveStatus, isActive, normalizeMemoryId, type MemoryFile } from "./store.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], details: {} });

// ---------- secret scan ----------

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: "API key (sk-…)" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: "GitHub token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/, label: "Bearer token" },
  { re: /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*\s*[:=>]\s*\S{8,}/i, label: "credential assignment" },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, label: "base64 blob" },
  { re: /\b[0-9a-f]{32,}\b/i, label: "hex blob" },
];

export function secretScan(text: string): { ok: boolean; reason?: string } {
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, reason: `rejected: looks like a secret: ${label}` };
  }
  return { ok: true };
}

// ---------- dedup ----------

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\W+/g, " ").trim();
}

function ngrams(text: string, n = 8): Set<string> {
  const words = text.toLowerCase().replace(/\W+/g, " ").trim().split(" ");
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export async function dedupCheck(
  store: MarkdownStore,
  cand: { title: string; body: string; type: MemoryType },
): Promise<MemoryFile | null> {
  const candGrams = ngrams(cand.body);
  for (const file of await store.all()) {
    if (file.type !== cand.type) continue;
    if (normalizeTitle(file.title) === normalizeTitle(cand.title)) return file;
    const bodyWords = file.body.toLowerCase().replace(/\W+/g, " ");
    for (const gram of candGrams) {
      if (bodyWords.includes(gram)) return file;
    }
  }
  return null;
}

// ---------- handlers ----------

const SNAPSHOT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Lexical overlap is topical similarity, not duplication: two shared title
// stems already clear any plausible threshold, so blocking on it caused
// unwinnable retry loops (every rephrase matched a different set). Only the
// true near-copy dedupCheck above blocks; the scored overlaps below are an
// advisory on the success path.
const OVERLAP_MIN = 3;

const rejectedSave = (reason: string, details: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: "text", text: reason }],
  details: { saved: false, reason, ...details },
});

export async function handleMemorySave(
  store: MarkdownStore,
  params: {
    type: MemoryType;
    title: string;
    body: string;
    scope?: "project" | "global";
    pinned?: boolean;
    supersedes?: string[];
    anchor?: string;
    expiresAfter?: string;
  },
): Promise<ToolResult> {
  return store.withMutation(async () => {
    const scan = secretScan(`${params.title}\n${params.body}`);
    if (!scan.ok) return rejectedSave(scan.reason ?? "rejected");

    // A snapshot is time-stamped state, not durable truth: it must say what it is
    // anchored to and when it stops being current, or it rots into a false fact.
    if (params.type === "snapshot") {
      if (params.anchor === undefined || params.anchor.trim() === "") {
        return rejectedSave("rejected: a snapshot needs an `anchor` (commit sha or file:line)");
      }
      if (
        params.expiresAfter === undefined ||
        !SNAPSHOT_ISO.test(params.expiresAfter) ||
        Number.isNaN(Date.parse(params.expiresAfter))
      ) {
        return rejectedSave("rejected: a snapshot needs `expiresAfter` as an ISO-8601 UTC timestamp");
      }
    }

    const supersedes = [
      ...new Set(
        (params.supersedes ?? [])
          .map((id) => normalizeMemoryId(id))
          .filter((id): id is string => id !== null),
      ),
    ];
    const scope = params.scope ?? "project";

    const dup = await dedupCheck(store, params);
    if (dup && isActive(dup) && !supersedes.includes(dup.id)) {
      return {
        content: [{
          type: "text",
          text: `Similar memory exists: [${dup.id}] ${dup.title} — resave with supersedes: ["${dup.id}"] to replace it, or rephrase.`,
        }],
        details: { saved: false, duplicate: true, id: dup.id },
      };
    }

    // Cheapest fix for the observed near-copies: the same lexical scorer search
    // uses runs at save time and hands the model the overlapping ids instead of
    // silently appending a fourth copy of the same decision.
    const candidates = (await store.all()).filter(
      (f) => f.scope === scope && f.type === params.type && isActive(f),
    );
    const overlaps = scoreFiles(candidates, `${params.title}\n${params.body}`)
      .filter((o) => o.score >= OVERLAP_MIN)
      .sort((a, b) => b.score - a.score || a.file.id.localeCompare(b.file.id))
      .slice(0, 3)
      .map((o) => ({ id: o.file.id, title: o.file.title, score: o.score }));

    const file = await store.save({ ...params, supersedes });
    const superseded: string[] = [];
    const supersedesNotFound: string[] = [];
    for (const id of supersedes) {
      const target = await store.get(id);
      if (!target) {
        supersedesNotFound.push(id);
        continue;
      }
      if (!isActive(target)) continue;
      target.status = "superseded";
      target.supersededBy = file.id;
      await store.update(target);
      superseded.push(target.id);
    }
    const details: Record<string, unknown> = { saved: true, id: file.id, scope: file.scope };
    if (superseded.length > 0) details.superseded = superseded;
    if (supersedesNotFound.length > 0) details.supersedesNotFound = supersedesNotFound;
    if (overlaps.length > 0) details.overlaps = overlaps;
    // details are UI-only; the model only sees content, so surface weak overlaps here too.
    // The advice is deliberately selective: superseding/archiving everything listed
    // would retire still-valid memories just to complete a save.
    const advisory =
      overlaps.length > 0
        ? `\nRelated (advisory, not duplicates): ${overlaps.map((o) => `[${o.id}] ${o.title}`).join("; ")}. ` +
          `If this memory fully replaces one of them, archive it afterwards with memory_forget (id, supersededBy: "${file.id}") — ` +
          `only the ones it actually replaces.`
        : "";
    return {
      content: [{ type: "text", text: `Saved ${file.scope} memory ${file.id}: ${file.title}${advisory}` }],
      details,
    };
  });
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "with",
  "use", "using", "how", "why", "what", "when", "we", "our", "you", "your", "it",
  "its", "be", "as", "at", "by", "from", "that", "this",
]);

// ---------- search relevance helpers ----------

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Light stemmer: strip common English inflections so e.g. "archiving" → "archiv"
// prefix-matches "archival", "tests" → "test", "retrying" → "retry".
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return term.slice(0, -3) + "y";
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  if (term.length > 4 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2);
  return term;
}

// Levenshtein distance ≤ 1 (true also when equal).
function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length) i++;
    j++;
  }
  return true; // at most one trailing char of b remains — that is the single edit
}

type MatchKind = "exact" | "fuzzy" | "none";

// Match a stemmed query term against a stemmed document token: exact, or
// word-start prefix (both stems ≥4 chars, so "test" cannot match "protest"),
// or one-edit fuzzy for typos (terms <4 chars are never fuzzy-matched).
function matchTerm(termStem: string, tokenStem: string): MatchKind {
  if (termStem === tokenStem) return "exact";
  if (
    termStem.length >= 4 &&
    tokenStem.length >= 4 &&
    (termStem.startsWith(tokenStem) || tokenStem.startsWith(termStem))
  ) {
    return "exact";
  }
  if (termStem.length >= 4 && withinEditDistance1(termStem, tokenStem)) return "fuzzy";
  return "none";
}

/**
 * Lexical relevance scorer shared by search and save-time overlap detection.
 * Pure: takes files + query, returns scored candidates (unsorted).
 */
export function scoreFiles(
  files: MemoryFile[],
  query: string,
): { file: MemoryFile; score: number }[] {
  const termStems = [...new Set(tokenize(query).map(stem))];
  if (termStems.length === 0 || files.length === 0) return [];
  const candidates = files.map((file) => ({
    file,
    titleStems: tokenize(file.title).map(stem),
    // previousTitles are searchable at body weight: superseded titles keep old vocabulary findable
    bodyStems: tokenize(`${file.body}\n${file.previousTitles.join("\n")}`).map(stem),
  }));
  // Noise gate: a term present in most bodies carries no discrimination, so it earns
  // no body points (title points are unaffected). Rare single-body hits stay visible.
  const bodyDf = new Map<string, number>();
  for (const term of termStems) {
    bodyDf.set(term, candidates.filter((c) => c.bodyStems.includes(term)).length);
  }
  const gated = (term: string) => {
    const df = bodyDf.get(term) ?? 0;
    return df >= 2 && df / candidates.length > 0.5;
  };
  const scored: { file: MemoryFile; score: number }[] = [];
  for (const c of candidates) {
    let score = 0;
    for (const term of termStems) {
      const titleKinds = c.titleStems.map((t) => matchTerm(term, t));
      if (titleKinds.includes("exact")) score += 3;
      else if (titleKinds.includes("fuzzy")) score += 1;
      if (!gated(term)) {
        if (c.bodyStems.some((t) => matchTerm(term, t) !== "none")) score += 1;
      }
    }
    if (score > 0) scored.push({ file: c.file, score });
  }
  return scored;
}

export async function handleMemorySearch(
  store: MarkdownStore,
  params: { query: string; scope?: "project" | "global" | "all"; type?: MemoryType; limit?: number },
): Promise<ToolResult> {
  const scopes: MemoryScope[] =
    params.scope === "project" ? ["project"] : params.scope === "global" ? ["global"] : ["project", "global"];
  const limit = params.limit ?? 10;
  const files: MemoryFile[] = [];
  for (const scope of scopes) {
    for (const file of await store.list(scope)) {
      if (params.type && file.type !== params.type) continue;
      files.push(file);
    }
  }
  // Inactive entries stay searchable for audit, but a large penalty keeps them
  // below every active hit; the line marks why so a stale hit is never mistaken
  // for current.
  const scored = scoreFiles(files, params.query)
    .map(({ file, score }) => ({ file, score: isActive(file) ? score : score - 1000 }))
    .sort((a, b) => b.score - a.score || b.file.strength - a.file.strength);
  const hits = scored.slice(0, limit);
  if (hits.length === 0) return text("No matching memories.");
  return text(
    [
      "Matching memories (id | type | title):",
      ...hits.map(({ file }) => {
        const status = effectiveStatus(file);
        const suffix =
          status === "active" ? "" : ` [${status}${file.supersededBy ? ` by ${file.supersededBy}` : ""}]`;
        return `- [${file.id}] ${file.type} | ${file.title}${suffix}`;
      }),
    ].join("\n"),
  );
}

export async function handleMemoryRead(store: MarkdownStore, params: { ids: string[] }): Promise<ToolResult> {
  const parts: string[] = [];
  const found: string[] = [];
  for (const id of params.ids) {
    const file = await store.get(id);
    if (!file) {
      parts.push(`[${id}] not found`);
      continue;
    }
    found.push(id);
    parts.push(`[${file.id}] (${file.type}, used ×${file.useCount}) ${file.title}\n${file.body}`);
  }
  if (found.length > 0) {
    try {
      await store.bumpUsage(found);
    } catch {
      // usage bump is best-effort; reads must continue even if writes fail
    }
  }
  return text(parts.join("\n\n"));
}

export async function handleMemoryForget(
  store: MarkdownStore,
  params: { id: string; reason?: string; supersededBy?: string },
): Promise<ToolResult> {
  // The tool schema requires `reason`; this default only covers direct callers
  // (tests, older transcripts) so archiving never loses the field entirely.
  return store.withMutation(async () => {
    const reason = params.reason?.trim() ? params.reason.trim() : "forgotten via memory_forget (no reason given)";
    if (params.supersededBy !== undefined) {
      const file = await store.get(params.id);
      if (file) {
        file.status = "superseded";
        file.supersededBy = params.supersededBy;
        await store.update(file);
      }
    }
    const note = params.supersededBy !== undefined ? `${reason}\nsupersededBy: ${params.supersededBy}` : reason;
    const ok = await store.moveToArchive(params.id, note);
    return {
      content: [{ type: "text", text: ok ? `Archived ${params.id}: ${reason}` : `${params.id} not found.` }],
      details: { forgotten: ok, reason, ...(params.supersededBy !== undefined ? { supersededBy: params.supersededBy } : {}) },
    };
  });
}

/**
 * Stamp a memory as re-checked against the repo. Verification is what makes
 * "verified beats merely-cited" ranking possible without re-reading every file.
 */
export async function handleMemoryVerify(
  store: MarkdownStore,
  params: { id: string; anchor?: string },
  now: Date = new Date(),
): Promise<ToolResult> {
  return store.withMutation(async () => {
    const file = await store.get(params.id);
    if (!file) return text(`${params.id} not found`);
    file.verifiedAt = now.toISOString();
    if (params.anchor !== undefined) file.anchor = params.anchor;
    await store.update(file);
    return {
      content: [{
        type: "text",
        text: `Verified ${file.id} at ${file.verifiedAt}${file.anchor ? ` (anchor: ${file.anchor})` : ""}.`,
      }],
      details: { verified: true, id: file.id, verifiedAt: file.verifiedAt, ...(file.anchor ? { anchor: file.anchor } : {}) },
    };
  });
}

/**
 * Paged enumeration for auditing the store without reading files off disk.
 * Unlike search, this lists entries and their metadata; bodies are never returned.
 */
export async function handleMemoryList(
  store: MarkdownStore,
  params: {
    scope?: "project" | "global" | "all";
    type?: MemoryType;
    status?: MemoryStatus | "all";
    limit?: number;
    offset?: number;
    includeArchive?: boolean;
  },
): Promise<ToolResult> {
  const scopes: MemoryScope[] =
    params.scope === "project" ? ["project"] : params.scope === "global" ? ["global"] : ["project", "global"];
  const files: MemoryFile[] = [];
  for (const scope of scopes) {
    files.push(...(await store.list(scope, { includeArchive: params.includeArchive === true })));
  }
  const filtered = files.filter((f) => {
    if (params.type && f.type !== params.type) return false;
    if (params.status && params.status !== "all" && effectiveStatus(f) !== params.status) return false;
    return true;
  });
  filtered.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  const offset = Math.max(0, params.offset ?? 0);
  const limit = Math.max(1, params.limit ?? 50);
  const page = filtered.slice(offset, offset + limit);
  const lines = page.map((f) => {
    let line = `- [${f.id}] ${f.type} | ${f.title} | s=${f.strength} | ${effectiveStatus(f)}`;
    if (f.anchor) line += ` | anchor=${f.anchor}`;
    if (f.verifiedAt) line += ` | verified=${f.verifiedAt}`;
    if (f.supersededBy) line += ` | supersededBy=${f.supersededBy}`;
    return line;
  });
  return {
    content: [{
      type: "text",
      text: [`Memories ${offset}-${offset + page.length} of ${filtered.length}:`, ...lines].join("\n"),
    }],
    details: { total: filtered.length, offset, limit, count: page.length },
  };
}
