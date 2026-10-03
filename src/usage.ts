import type { MarkdownStore } from "./store.js";

export function computeStrength(
  useCount: number,
  lastUsedIso: string,
  now: Date,
  cfg: { halfLifeDays: number },
): number {
  const base = Math.min(1, 0.3 + 0.1 * useCount);
  // abs: brief's Math.max(0, ...) clamp fails its own tests (future lastUsedIso must decay too);
  // identical behavior for real data where lastUsed <= now.
  const days = Math.abs(now.getTime() - Date.parse(lastUsedIso)) / 86400000;
  const strength = base * Math.pow(0.5, days / cfg.halfLifeDays);
  return Math.round(strength * 1000) / 1000;
}

export async function applyDecayAndPrune(
  store: MarkdownStore,
  cfg: { halfLifeDays: number; pruneDays: number; pruneStrength: number },
  now: Date,
): Promise<{ pruned: string[] }> {
  return store.withMutation(async () => {
    const pruned: string[] = [];
    for (const file of await store.all()) {
      const next = computeStrength(file.useCount, file.lastUsed, now, cfg);
      const ageDays = (now.getTime() - Date.parse(file.lastUsed)) / 86400000;
      if (!file.pinned && ageDays > cfg.pruneDays && next < cfg.pruneStrength) {
        if (await store.moveToArchive(file.id, "decayed: unused and weak")) {
          pruned.push(file.id);
          continue;
        }
      }
      // Only persist a decay that actually moved the rounded strength. Decay is
      // continuous, so an unconditional write rewrote every memory (and its index)
      // on every idle tick — needless churn and sync conflicts on a shared store.
      if (next === file.strength) continue;
      file.strength = next;
      await store.update(file);
    }
    return { pruned };
  });
}
