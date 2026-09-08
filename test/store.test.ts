import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore } from "../src/store.js";

let root: string;
let store: MarkdownStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pimem-"));
  store = new MarkdownStore(root, "testproj");
  await store.init();
});

const mem = (over: Partial<Parameters<MarkdownStore["save"]>[0]> = {}) => ({
  type: "decision" as const,
  title: "Use pnpm workspace filters for test runs",
  body: "Filter to the touched workspace to keep CI under 5 minutes.",
  ...over,
});

describe("MarkdownStore", () => {
  it("save assigns id, defaults, writes file, updates index", async () => {
    const f = await store.save(mem());
    expect(f.id).toMatch(/^mem-[0-9a-f]{8}$/);
    expect(f.strength).toBe(0.5);
    expect(f.useCount).toBe(0);
    expect(f.scope).toBe("project");
    const lines = await store.indexLines("project");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(f.id);
  });

  it("get finds project then global", async () => {
    const p = await store.save(mem());
    const g = await store.save(mem({ scope: "global" }));
    expect((await store.get(p.id))?.scope).toBe("project");
    expect((await store.get(g.id))?.scope).toBe("global");
    expect(await store.get("mem-00000000")).toBeUndefined();
  });

  it("list sorts by strength desc and skips corrupt files", async () => {
    const { writeFile } = await import("node:fs/promises");
    await store.save(mem({ title: "low" }));
    const high = await store.save(mem({ title: "high" }));
    high.strength = 0.9;
    await store.update(high);
    await writeFile(join(store.scopeDir("project"), "mem-badbad00.md"), "corrupt", "utf8");
    const files = await store.list("project");
    expect(files.map((f) => f.title)).toEqual(["high", "low"]);
  });

  it("list skips corrupt files and counts them in corruptCount", async () => {
    const { writeFile } = await import("node:fs/promises");
    await store.save(mem({ title: "valid" }));
    await writeFile(
      join(store.scopeDir("project"), "mem-badbad01.md"),
      "---\ntype: decision\n---\nno id means corrupt",
      "utf8",
    );
    const files = await store.list("project");
    expect(files.map((f) => f.title)).toEqual(["valid"]);
    expect(store.corruptCount).toBe(1);
  });

  it("bumpUsage increments useCount and sets lastUsed", async () => {
    const f = await store.save(mem());
    const now = new Date("2026-09-08T12:00:00.000Z");
    expect(await store.bumpUsage([f.id], now)).toBe(1);
    const got = await store.get(f.id);
    expect(got?.useCount).toBe(1);
    expect(got?.lastUsed).toBe("2026-09-08T12:00:00.000Z");
  });

  it("moveToArchive removes from index and writes reason sidecar", async () => {
    const f = await store.save(mem());
    expect(await store.moveToArchive(f.id, "obsolete")).toBe(true);
    expect(await store.get(f.id)).toBeUndefined();
    expect(await store.indexLines("project")).toHaveLength(0);
    const { readdir } = await import("node:fs/promises");
    const archived = await readdir(store.archiveDir("project"));
    expect(archived.some((n) => n.endsWith(".md"))).toBe(true);
    expect(archived.some((n) => n.startsWith(".reason-"))).toBe(true);
  });

  it("regenerateIndex enforces line and byte caps with trailer", async () => {
    const limits = { indexMaxLines: 3, indexMaxBytes: 4000 };
    const small = new MarkdownStore(root, "testproj", limits);
    await small.init();
    for (let i = 0; i < 5; i++) await small.save(mem({ title: `memory number ${i}` }));
    const lines = await small.indexLines("project");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/…3 more — use memory_search/);
  });

  it("nextId avoids collisions", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(await store.nextId());
    expect(seen.size).toBe(5);
  });
});
