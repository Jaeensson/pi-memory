import type { MemoryScope, MemoryType } from "./store.js";
import { MarkdownStore, type MemoryFile } from "./store.js";

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

export async function handleMemorySave(
  store: MarkdownStore,
  params: { type: MemoryType; title: string; body: string; scope?: "project" | "global" },
): Promise<ToolResult> {
  const scan = secretScan(`${params.title}\n${params.body}`);
  if (!scan.ok) {
    return { content: [{ type: "text", text: scan.reason ?? "rejected" }], details: { saved: false, reason: scan.reason } };
  }
  const dup = await dedupCheck(store, params);
  if (dup) {
    return {
      content: [{
        type: "text",
        text: `Similar memory exists: [${dup.id}] ${dup.title} — use /memory to edit or rephrase.`,
      }],
      details: { saved: false, duplicate: true, id: dup.id },
    };
  }
  const file = await store.save(params);
  return {
    content: [{ type: "text", text: `Saved ${file.scope} memory ${file.id}: ${file.title}` }],
    details: { saved: true, id: file.id, scope: file.scope },
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "with",
  "use", "using", "how", "why", "what", "when", "we", "our", "you", "your", "it",
  "its", "be", "as", "at", "by", "from", "that", "this",
]);

export async function handleMemorySearch(
  store: MarkdownStore,
  params: { query: string; scope?: "project" | "global" | "all"; type?: MemoryType; limit?: number },
): Promise<ToolResult> {
  const terms = params.query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (terms.length === 0) return text("No usable search terms.");
  const scopes: MemoryScope[] =
    params.scope === "project" ? ["project"] : params.scope === "global" ? ["global"] : ["project", "global"];
  const limit = params.limit ?? 10;
  const scored: { file: MemoryFile; score: number }[] = [];
  for (const scope of scopes) {
    for (const file of await store.list(scope)) {
      if (params.type && file.type !== params.type) continue;
      const title = file.title.toLowerCase();
      const body = file.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ file, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.file.strength - a.file.strength);
  const hits = scored.slice(0, limit);
  if (hits.length === 0) return text("No matching memories.");
  return text(
    ["Matching memories (id | type | title):", ...hits.map(({ file }) => `- [${file.id}] ${file.type} | ${file.title}`)].join("\n"),
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

export async function handleMemoryForget(store: MarkdownStore, params: { id: string }): Promise<ToolResult> {
  const ok = await store.moveToArchive(params.id, "forgotten via memory_forget");
  return {
    content: [{ type: "text", text: ok ? `Archived ${params.id}.` : `${params.id} not found.` }],
    details: { forgotten: ok },
  };
}
