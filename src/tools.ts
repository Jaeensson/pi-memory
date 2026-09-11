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

export async function handleMemorySearch(
  store: MarkdownStore,
  params: { query: string; scope?: "project" | "global" | "all"; type?: MemoryType; limit?: number },
): Promise<ToolResult> {
  const termStems = [...new Set(tokenize(params.query).map(stem))];
  if (termStems.length === 0) return text("No usable search terms.");
  const scopes: MemoryScope[] =
    params.scope === "project" ? ["project"] : params.scope === "global" ? ["global"] : ["project", "global"];
  const limit = params.limit ?? 10;
  const candidates: { file: MemoryFile; titleStems: string[]; bodyStems: string[] }[] = [];
  for (const scope of scopes) {
    for (const file of await store.list(scope)) {
      if (params.type && file.type !== params.type) continue;
      candidates.push({
        file,
        titleStems: tokenize(file.title).map(stem),
        // previousTitles are searchable at body weight: superseded titles keep old vocabulary findable
        bodyStems: tokenize(`${file.body}\n${file.previousTitles.join("\n")}`).map(stem),
      });
    }
  }
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
