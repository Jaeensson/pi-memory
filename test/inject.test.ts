import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { estimateTokens, renderMemoryBlock, trimIndexLines } from "../src/inject.js";
import type { MemoryFile } from "../src/store.js";

const pin = (id: string, body: string): MemoryFile => ({
  id,
  type: "lesson",
  title: `pin ${id}`,
  created: "2026-09-01T00:00:00.000Z",
  lastUsed: "2026-09-01T00:00:00.000Z",
  useCount: 0,
  strength: 0.5,
  scope: "project",
  pinned: true,
  revision: 0,
  previousTitles: [],
  body,
});

describe("estimateTokens", () => {
  it("ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("trimIndexLines", () => {
  it("keeps lines within the token budget and appends overflow trailer", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `- [mem-0000000${i}] (fact) memory title ${i}`);
    const { kept, dropped } = trimIndexLines(lines, 400);
    expect(kept.length).toBeLessThan(100);
    expect(dropped).toBe(100 - kept.length);
    expect(kept[kept.length - 1]).toMatch(/…\d+ more — use memory_search/);
  });

  it("never returns an empty trailer for exactly-fitting input", () => {
    const lines = ["- [mem-00000001] (fact) one"];
    const { kept, dropped } = trimIndexLines(lines, 400);
    expect(kept).toEqual(lines);
    expect(dropped).toBe(0);
  });

  it("returns an empty lane when the budget cannot fit even the trailer", () => {
    const { kept, dropped, tokens } = trimIndexLines(["- [mem-00000001] (fact) one"], 0);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
    expect(tokens).toBe(0);
  });
});

describe("renderMemoryBlock", () => {
  it("renders all three lanes and respects total shape", () => {
    const out = renderMemoryBlock(
      {
        pinned: [pin("mem-11111111", "never push to main")],
        projectIndex: ["- [mem-22222222] (decision ×3) Use pnpm filters"],
        globalIndex: ["- [mem-33333333] (lesson) Ask before destructive db ops"],
      },
      DEFAULT_CONFIG,
    );
    expect(out.text).toContain("## Memory");
    expect(out.text).toContain("never push to main");
    expect(out.text).toContain("[mem-22222222]");
    expect(out.text).toContain("[mem-33333333]");
    expect(out.text).toContain("memory_read");
    expect(out.text).toContain("memory_save");
    expect(out.text).toContain("correct");
    expect(out.tokens.pinned).toBeLessThanOrEqual(DEFAULT_CONFIG.pinnedMaxTokens);
    expect(out.tokens.index).toBeLessThanOrEqual(DEFAULT_CONFIG.indexMaxTokens);
  });

  it("caps the composite index lane even when one project line fills the budget", () => {
    // 24-char prefix + 1572 filler = 1596 chars ≈ 399 tokens (+1 newline = 400).
    const bigLine = `- [mem-44444444] (fact) ${"y".repeat(1572)}`;
    expect(estimateTokens(bigLine) + 1).toBe(DEFAULT_CONFIG.indexMaxTokens);
    const out = renderMemoryBlock(
      {
        pinned: [],
        projectIndex: [bigLine],
        globalIndex: ["- [mem-55555555] (lesson) Ask before destructive db ops"],
      },
      DEFAULT_CONFIG,
    );
    expect(out.tokens.index).toBeLessThanOrEqual(DEFAULT_CONFIG.indexMaxTokens);
    // Global lane contributes nothing: no global entry, no overflow trailer.
    expect(out.text).not.toContain("[mem-55555555]");
    expect(out.text).not.toContain("more — use memory_search");
  });

  it("drops oldest pins first when over the pinned budget", () => {
    const old = pin("mem-11111111", "x".repeat(900));
    const recent = pin("mem-22222222", "short");
    old.lastUsed = "2026-08-01T00:00:00.000Z";
    recent.lastUsed = "2026-09-01T00:00:00.000Z";
    const out = renderMemoryBlock({ pinned: [old, recent], projectIndex: [], globalIndex: [] }, DEFAULT_CONFIG);
    expect(out.text).toContain("short");
    expect(out.text).not.toContain("xxxxx");
  });
});
