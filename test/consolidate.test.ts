import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  applyOps,
  buildExtractionPrompt,
  parseOps,
  runConsolidation,
  transcriptFromEntries,
  WatermarkStore,
  type SessionEntryLike,
} from "../src/consolidate.js";
import { MarkdownStore } from "../src/store.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("parseOps", () => {
  it("parses a clean JSON array", () => {
    const ops = parseOps(
      JSON.stringify([
        { op: "ADD", type: "lesson", title: "T", body: "B", scope: "project", confidence: 0.9 },
        { op: "NOOP" },
      ]),
      12,
    );
    expect(ops).toHaveLength(2);
    expect(ops[0].op).toBe("ADD");
  });

  it("extracts the array from surrounding prose and drops invalid entries", () => {
    const raw = `Here you go:\n[${JSON.stringify({ op: "ADD", type: "weird", title: "T", body: "B", scope: "project", confidence: 0.9 })},${JSON.stringify({ op: "DELETE", targetId: "mem-a1b2c3d4" })}]\nDone.`;
    const ops = parseOps(raw, 12);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("DELETE");
  });

  it("caps at maxOps", () => {
    const raw = JSON.stringify(
      Array.from({ length: 20 }, () => ({ op: "NOOP" })),
    );
    expect(parseOps(raw, 12)).toHaveLength(12);
  });

  it("returns [] on garbage", () => {
    expect(parseOps("not json at all", 12)).toEqual([]);
  });
});

describe("transcriptFromEntries", () => {
  const entries: SessionEntryLike[] = [
    { id: "e1", type: "message", message: { role: "user", content: "Please set up vitest" } },
    {
      id: "e2",
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm i vitest" } }] },
    },
    {
      id: "e3",
      type: "message",
      message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(1000) }] },
    },
    { id: "e4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    { id: "e5", type: "model_change" },
  ];

  it("formats roles, elides tool output to 200 chars, skips non-message entries", () => {
    const { text, lastId } = transcriptFromEntries(entries, null, 30000);
    expect(text).toContain("## USER");
    expect(text).toContain("Please set up vitest");
    expect(text).toContain("[called tool bash]");
    expect(text).toContain("## TOOL bash");
    expect(text).not.toContain("x".repeat(300)); // elided
    expect(text).toContain("Done.");
    expect(lastId).toBe("e4");
  });

  it("only includes entries after lastEntryId", () => {
    const { text, lastId } = transcriptFromEntries(entries, "e1", 30000);
    expect(text).not.toContain("Please set up vitest");
    expect(lastId).toBe("e4");
  });

  it("truncates head+tail at maxChars", () => {
    const long: SessionEntryLike[] = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      type: "message",
      message: { role: "user", content: `filler ${i} ${"y".repeat(200)}` },
    }));
    const { text } = transcriptFromEntries(long, null, 2000);
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain("…[truncated]…");
  });

  it("returns empty text and null lastId for no new entries", () => {
    const { text, lastId } = transcriptFromEntries(entries, "e4", 30000);
    expect(text).toBe("");
    expect(lastId).toBeNull();
  });

  it("falls back to a bounded tail when the watermark is stale (branch changed)", () => {
    const { text, lastId } = transcriptFromEntries(entries, "ffffff00", 30000);
    expect(text).toContain("Please set up vitest"); // processed from tail, not stuck
    expect(lastId).toBe("e4");
  });
});

describe("applyOps", () => {
  let store: MarkdownStore;
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    store = new MarkdownStore(root, "testproj");
    await store.init();
  });

  it("adds above-confidence memories after secret+dedup gates", async () => {
    const applied = await applyOps(
      store,
      [{ op: "ADD", type: "lesson", title: "T", body: "B", scope: "project", confidence: 0.9 },
       { op: "ADD", type: "fact", title: "low", body: "b", scope: "project", confidence: 0.5 },
       { op: "ADD", type: "fact", title: "secret", body: "key sk-abcdefghijklmnop123456", scope: "project", confidence: 0.9 }],
      { maxOpsPerRun: 12 },
      NOW,
    );
    expect(applied.added).toHaveLength(1);
    expect(applied.skipped).toBe(2);
    expect(applied.notes.join(" ")).toMatch(/secret/i);
  });

  it("updates in place with revision + previousTitles and bumps lastUsed", async () => {
    const f = await store.save({ type: "decision", title: "Old", body: "old body" });
    const oldDate = new Date(NOW.getTime() - 5 * 86400000).toISOString();
    const file = await store.get(f.id);
    file!.lastUsed = oldDate;
    await store.update(file!);
    await applyOps(store, [{ op: "UPDATE", targetId: f.id, title: "New", body: "new body", reason: "changed" }], { maxOpsPerRun: 12 }, NOW);
    const got = await store.get(f.id);
    expect(got?.title).toBe("New");
    expect(got?.body).toBe("new body");
    expect(got?.revision).toBe(1);
    expect(got?.previousTitles).toEqual(["Old"]);
    expect(got?.lastUsed).toBe(NOW.toISOString());
  });

  it("archives on DELETE with a reason sidecar", async () => {
    const f = await store.save({ type: "fact", title: "T", body: "b" });
    await applyOps(store, [{ op: "DELETE", targetId: f.id, reason: "obsolete" }], { maxOpsPerRun: 12 }, NOW);
    expect(await store.get(f.id)).toBeUndefined();
    const { readdir } = await import("node:fs/promises");
    const archived = await readdir(store.archiveDir("project"));
    expect(archived.some((n) => n.startsWith(".reason-"))).toBe(true);
  });
});

describe("runConsolidation", () => {
  let root: string;
  let store: MarkdownStore;
  let entries: SessionEntryLike[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pimem-"));
    store = new MarkdownStore(root, "testproj");
    await store.init();
    entries = [
      { id: "e1", type: "message", message: { role: "user", content: "we decided: always use pnpm filters for tests" } },
      { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } },
    ];
  });

  it("extracts, applies, advances watermark", async () => {
    const complete = async () =>
      JSON.stringify([
        { op: "ADD", type: "decision", title: "Use pnpm filters for tests", body: "Speeds up CI.", scope: "project", confidence: 0.95 },
      ]);
    const res = await runConsolidation(store, entries, {
      complete,
      cfg: DEFAULT_CONFIG,
      sessionId: "s1",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.applied?.added).toHaveLength(1);
    const wm = await new WatermarkStore(store.scopeDir("project")).read();
    expect(wm.lastEntryId).toBe("e2");
    expect(wm.sessionId).toBe("s1");
    expect((await store.list("project")).some((f) => f.title === "Use pnpm filters for tests")).toBe(true);
  });

  it("skips the LLM when there is nothing new but still prunes", async () => {
    const wmStore = new WatermarkStore(store.scopeDir("project"));
    await wmStore.write({ sessionId: "s1", lastEntryId: "e2", lastConsolidatedAt: NOW.toISOString() });
    let called = 0;
    const complete = async () => {
      called += 1;
      return "[]";
    };
    const res = await runConsolidation(store, entries, { complete, cfg: DEFAULT_CONFIG, sessionId: "s1", now: NOW });
    expect(called).toBe(0);
    expect(res.ok).toBe(true);
  });

  it("reports failure without throwing when the model call fails", async () => {
    const res = await runConsolidation(store, entries, {
      complete: async () => {
        throw new Error("api down");
      },
      cfg: DEFAULT_CONFIG,
      sessionId: "s1",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/api down/);
    const wm = await new WatermarkStore(store.scopeDir("project")).read();
    expect(wm.lastEntryId).toBeNull(); // watermark untouched on failure
  });

  it("buildExtractionPrompt includes index and rules", () => {
    const prompt = buildExtractionPrompt(["- [mem-a1b2c3d4] (fact) x"], "TRANSCRIPT");
    expect(prompt).toContain("mem-a1b2c3d4");
    expect(prompt).toContain("TRANSCRIPT");
    expect(prompt).toContain("ADD");
    expect(prompt).toContain("UPDATE");
    expect(prompt).toContain("DELETE");
    expect(prompt).toContain("derivable from the codebase");
  });
});
