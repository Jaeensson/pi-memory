import type { MemoryConfig } from "./config.js";
import { indexLine, type MarkdownStore, type MemoryFile } from "./store.js";

export const POLICY_TEXT =
  "Use memory_search <query> to find more. Save durable decisions, facts, and " +
  "lessons with memory_save — save immediately when the user corrects you. When a new " +
  "decision replaces an old memory, pass supersedes: [id]; re-check important claims " +
  "with memory_verify.";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface InjectionInput {
  pinned: MemoryFile[];
  projectIndex: string[];
  globalIndex: string[];
}

export function trimIndexLines(
  lines: string[],
  maxTokens: number,
): { kept: string[]; dropped: number; tokens: number } {
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens) break;
    kept.push(line);
    tokens += cost;
  }
  const hidden = lines.length - kept.length;
  if (hidden > 0) {
    // Reserve a slot for the trailer: drop entry lines until it fits, keeping the
    // kept lines within maxTokens (mirrors MarkdownStore.regenerateIndex). The
    // count is honest: entries shown + N = total input lines.
    while (kept.length > 0) {
      const cost = estimateTokens(`…${lines.length - kept.length} more — use memory_search`) + 1;
      if (tokens + cost <= maxTokens) break;
      tokens -= estimateTokens(kept.pop()!) + 1;
    }
    const trailer = `…${lines.length - kept.length} more — use memory_search`;
    const trailerCost = estimateTokens(trailer) + 1;
    if (tokens + trailerCost > maxTokens) {
      // The budget cannot fit even the trailer: emit an empty lane rather than breach.
      return { kept: [], dropped: lines.length, tokens: 0 };
    }
    kept.push(trailer);
    tokens += trailerCost;
  }
  return { kept, dropped: lines.length - kept.length, tokens };
}

export async function gatherInjection(
  store: MarkdownStore,
  cfg: MemoryConfig,
): Promise<InjectionInput> {
  const now = new Date();
  // One directory read per scope serves both the pinned lane and the index lane,
  // so the hot path does not re-read the whole store per lane.
  const project = await store.activeFiles("project", now);
  const global = cfg.globalEnabled ? await store.activeFiles("global", now) : [];
  const pinned = [...project, ...global]
    .filter((f) => f.pinned)
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
  return {
    pinned,
    // Computed from files (not the on-disk INDEX.md) so a snapshot that just passed
    // its expiresAfter drops out immediately, and superseded entries never inject.
    projectIndex: project.map(indexLine),
    globalIndex: global.map(indexLine),
  };
}

export function renderMemoryBlock(
  input: InjectionInput,
  cfg: MemoryConfig,
): { text: string; tokens: { pinned: number; index: number } } {
  const out: string[] = ["## Memory"];

  // Pinned lane: pins are sorted newest-first (by gatherInjection), so once the
  // budget is exhausted this `continue` skips every remaining (older) pin.
  const pinLines: string[] = [];
  let pinTokens = 0;
  for (const p of input.pinned) {
    const line = `- [${p.id}] ${p.body}`;
    const cost = estimateTokens(line) + 1;
    if (pinTokens + cost > cfg.pinnedMaxTokens) continue;
    pinLines.push(line);
    pinTokens += cost;
  }
  if (pinLines.length > 0) {
    out.push("Pinned instructions (always apply):", ...pinLines);
  }

  // Index lane: both sub-lanes share the same per-line token accounting, so the
  // global budget is exactly what the project lane did not spend of the cap.
  const project = trimIndexLines(input.projectIndex, cfg.indexMaxTokens);
  const remaining = Math.max(0, cfg.indexMaxTokens - project.tokens);
  const global = trimIndexLines(input.globalIndex, remaining);
  const indexLines = [...project.kept, ...global.kept];
  if (indexLines.length > 0) {
    out.push(
      "Relevant memories for this project (details via memory_read <id>):",
      ...indexLines,
    );
  }

  out.push(POLICY_TEXT);
  return {
    text: out.join("\n"),
    tokens: { pinned: pinTokens, index: project.tokens + global.tokens },
  };
}
