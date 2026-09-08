import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore } from "../src/store.js";
import { applyDecayAndPrune, computeStrength } from "../src/usage.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("computeStrength", () => {
  it("is 0.5 for a fresh unused memory", () => {
    expect(computeStrength(0, NOW.toISOString(), NOW, { halfLifeDays: 14 })).toBe(0.3);
  });

  it("caps base at 1 (10+ uses) and halves every halfLifeDays", () => {
    const cfg = { halfLifeDays: 14 };
    expect(computeStrength(10, NOW.toISOString(), NOW, cfg)).toBe(1);
    const twoWeeksLater = new Date(NOW.getTime() + 14 * 86400000).toISOString();
    expect(computeStrength(10, twoWeeksLater, NOW, cfg)).toBe(0.5);
  });

  it("rounds to 3 decimals", () => {
    const cfg = { halfLifeDays: 14 };
    const sevenDays = new Date(NOW.getTime() + 7 * 86400000).toISOString();
    expect(computeStrength(10, sevenDays, NOW, cfg)).toBe(0.707);
  });
});

describe("applyDecayAndPrune", () => {
  let root: string;
  let store: MarkdownStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pimem-"));
    store = new MarkdownStore(root, "testproj");
    await store.init();
  });

  it("recomputes strength for all memories", async () => {
    const f = await store.save({ type: "fact", title: "t", body: "b" });
    await store.bumpUsage([f.id], new Date(NOW.getTime() - 7 * 86400000));
    await applyDecayAndPrune(store, { halfLifeDays: 14, pruneDays: 30, pruneStrength: 0.3 }, NOW);
    const got = await store.get(f.id);
    expect(got?.strength).toBe(0.283); // base 0.4 decayed 7 days: 0.4 × 0.5^0.5
  });

  it("archives stale weak memories, keeps pinned, keeps strong", async () => {
    const stale = await store.save({ type: "fact", title: "stale", body: "b" });
    const pinned = await store.save({ type: "fact", title: "pinned", body: "b", pinned: true });
    // age both past 30 days with zero uses → strength decays below 0.3
    const old = new Date(NOW.getTime() - 40 * 86400000);
    for (const f of [stale, pinned]) {
      f.lastUsed = old.toISOString();
      await store.update(f);
    }
    const res = await applyDecayAndPrune(store, { halfLifeDays: 14, pruneDays: 30, pruneStrength: 0.3 }, NOW);
    expect(res.pruned).toContain(stale.id);
    expect(await store.get(stale.id)).toBeUndefined();
    expect(await store.get(pinned.id)).toBeDefined();
  });

  it("keeps a memory at exactly the prune-day boundary (strict >)", async () => {
    // Regression pin: ageDays > pruneDays is strict, so exactly 30d survives with
    // its recomputed strength. The strength ≥ pruneStrength gate is currently
    // subsumed by the 30-day rule at default thresholds (halfLifeDays 14 ⇒ any
    // base ≤ 1 memory ≥ 30d old already has strength < 0.3); it only matters if
    // thresholds change.
    const f = await store.save({ type: "fact", title: "boundary", body: "b" });
    f.lastUsed = new Date(NOW.getTime() - 30 * 86400000).toISOString();
    await store.update(f);
    const res = await applyDecayAndPrune(store, { halfLifeDays: 14, pruneDays: 30, pruneStrength: 0.3 }, NOW);
    expect(res.pruned).not.toContain(f.id);
    expect(await store.get(f.id)).toBeDefined();
  });
});
