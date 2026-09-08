import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildPreview, formatMemoryLabel } from "../src/commands.js";
import { MarkdownStore, type MemoryFile } from "../src/store.js";

const file = (over: Partial<MemoryFile> = {}): MemoryFile => ({
  id: "mem-a1b2c3d4",
  type: "decision",
  title: "Use pnpm filters",
  created: "2026-09-01T00:00:00.000Z",
  lastUsed: "2026-09-01T00:00:00.000Z",
  useCount: 2,
  strength: 0.61,
  scope: "project",
  pinned: false,
  revision: 0,
  previousTitles: [],
  body: "b",
  ...over,
});

describe("formatMemoryLabel", () => {
  it("formats id, type, uses, strength, title", () => {
    expect(formatMemoryLabel(file())).toBe("[mem-a1b2c3d4] (decision ×2 s=0.61) Use pnpm filters");
  });
});

describe("buildPreview", () => {
  it("includes pinned, index, and policy content from the store", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    const store = new MarkdownStore(root, "testproj");
    await store.init();
    await store.save({ type: "decision", title: "Use pnpm filters", body: "CI speed." });
    const preview = await buildPreview(store, DEFAULT_CONFIG);
    expect(preview).toContain("## Memory");
    expect(preview).toContain("Use pnpm filters");
    expect(preview).toContain("memory_save");
  });
});
