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
      file.strength = computeStrength(file.useCount, file.lastUsed, now, cfg);
      const ageDays = (now.getTime() - Date.parse(file.lastUsed)) / 86400000;
      if (!file.pinned && ageDays > cfg.pruneDays && file.strength < cfg.pruneStrength) {
        if (await store.moveToArchive(file.id, "decayed: unused and weak")) {
          pruned.push(file.id);
          continue;
        }
      }
      await store.update(file);
    }
    return { pruned };
  });
}
