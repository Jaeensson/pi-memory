import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore, normalizeMemoryId } from "../src/store.js";

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

  it("get accepts a bare 8-hex id without the mem- prefix", async () => {
    const f = await store.save(mem());
    const bare = f.id.slice("mem-".length);
    expect((await store.get(bare))?.id).toBe(f.id);
  });

  it("get rejects malformed ids instead of guessing", async () => {
    const f = await store.save(mem());
    const bare = f.id.slice("mem-".length);
    expect(await store.get(bare.slice(0, 7))).toBeUndefined(); // too short
    expect(await store.get("mem-zzzzzzzz")).toBeUndefined(); // not hex
    expect(await store.get(`${bare}.md`)).toBeUndefined(); // filename, not id
  });

  it("moveToArchive accepts a bare 8-hex id", async () => {
    const f = await store.save(mem());
    expect(await store.moveToArchive(f.id.slice("mem-".length), "obsolete")).toBe(true);
    expect(await store.get(f.id)).toBeUndefined();
  });

  it("moveToArchive returns false for a malformed id", async () => {
    await store.save(mem());
    expect(await store.moveToArchive("not-an-id", "obsolete")).toBe(false);
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

  it("list ignores noncanonical conflict-copy filenames without counting them as corrupt", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const saved = await store.save(mem({ title: "valid" }));
    const dir = store.scopeDir("project");
    const canonical = await readFile(join(dir, `${saved.id}.md`), "utf8");
    await writeFile(join(dir, `${saved.id}-omen-safeBackup-0001.md`), canonical, "utf8");
    await writeFile(join(dir, "INDEX-omen-safeBackup-0001.md"), "stale generated index", "utf8");

    const files = await store.list("project");
    expect(files.map((f) => f.title)).toEqual(["valid"]);
    expect(store.corruptCount).toBe(0);
  });

  it("list skips corrupt canonical memory files and counts them in corruptCount", async () => {
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

  it("rebuilds the index once per scope for a batched mutation", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await store.save(mem({ title: `batched ${i}` }))).id);
    let regens = 0;
    const target = store as unknown as Record<string, unknown>;
    const original = (target.regenerateIndexUnlocked as (scope: string) => Promise<void>).bind(store);
    target.regenerateIndexUnlocked = (scope: string) => {
      regens += 1;
      return original(scope);
    };
    await store.bumpUsage(ids);
    // Five writes in one mutation → one index rebuild, not five.
    expect(regens).toBe(1);
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

  it("handles concurrent saves without tmp-file collisions or a torn index", async () => {
    // pi runs tool calls in parallel by default; several saves in one batch must
    // not share writeAtomic tmp filenames or leave INDEX.md missing entries.
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.save({ type: "decision", title: `concurrent ${i}`, body: `body ${i}` }),
      ),
    );
    const ids = saved.map((f) => f.id);
    expect(new Set(ids).size).toBe(10);
    const lines = await store.indexLines("project");
    for (const id of ids) {
      expect(lines.some((l) => l.includes(id))).toBe(true); // every memory in the index
    }
    // A second concurrent wave (exercises queued index regeneration ordering).
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.save({ type: "fact", title: `wave2 ${i}`, body: `b ${i}` }),
      ),
    );
    const lines2 = await store.indexLines("project");
    expect(lines2.length).toBeGreaterThanOrEqual(10);
  });
});

describe("normalizeMemoryId", () => {
  it("adds the mem- prefix to a bare 8-hex id", () => {
    expect(normalizeMemoryId("09839b44")).toBe("mem-09839b44");
  });

  it("leaves a canonical id unchanged and lowercases it", () => {
    expect(normalizeMemoryId("mem-09839b44")).toBe("mem-09839b44");
    expect(normalizeMemoryId("MEM-0983ABCD")).toBe("mem-0983abcd");
  });

  it("returns null for anything that is not an 8-hex id", () => {
    expect(normalizeMemoryId("09839b4")).toBeNull(); // too short
    expect(normalizeMemoryId("09839b444")).toBeNull(); // too long
    expect(normalizeMemoryId("mem-zzzzzzzz")).toBeNull(); // not hex
    expect(normalizeMemoryId("09839b44.md")).toBeNull(); // filename
    expect(normalizeMemoryId("../secret")).toBeNull(); // path traversal
  });
});
