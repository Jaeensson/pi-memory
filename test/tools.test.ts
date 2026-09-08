import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore } from "../src/store.js";
import {
  dedupCheck,
  handleMemoryForget,
  handleMemoryRead,
  handleMemorySave,
  handleMemorySearch,
  secretScan,
} from "../src/tools.js";

let store: MarkdownStore;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pimem-"));
  store = new MarkdownStore(root, "testproj");
  await store.init();
});

describe("secretScan", () => {
  it.each([
    ["my key is sk-abcdefghijklmnop123456", "API key"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS"],
    ["token ghp_abcdefghijklmnopqrstuvwx", "GitHub"],
    ["xoxb-123456789012-abc", "Slack"],
    ["Authorization: Bearer abcdefghijklmnopqrst", "Bearer"],
    ["API_KEY=supersecret123", "assignment"],
    ["AAAAcHJldGVuZGVkLWxvbmctYmFzZTY0LWJsb2JiYXR0ZWhjb2Rl", "base64"],
    ["deadbeefdeadbeefdeadbeefdeadbeef1", "hex"],
  ])("rejects %s", (text) => {
    expect(secretScan(text).ok).toBe(false);
  });

  it("allows normal prose", () => {
    expect(secretScan("We chose pnpm because workspaces are faster.").ok).toBe(true);
  });
});

describe("dedupCheck", () => {
  it("flags identical normalized titles", async () => {
    await store.save({ type: "decision", title: "Use pnpm filters", body: "b" });
    const hit = await dedupCheck(store, { title: "use pnpm filters", body: "other", type: "decision" });
    expect(hit).not.toBeNull();
  });

  it("flags shared 8-word body sequences of same type", async () => {
    await store.save({
      type: "lesson",
      title: "other title",
      body: "one two three four five six seven eight nine ten",
    });
    const hit = await dedupCheck(store, {
      title: "different title",
      body: "prefix one two three four five six seven eight nine ten suffix",
      type: "lesson",
    });
    expect(hit).not.toBeNull();
  });

  it("ignores different-type memories and non-overlapping bodies", async () => {
    await store.save({ type: "fact", title: "t1", body: "alpha beta gamma delta epsilon zeta" });
    const hit = await dedupCheck(store, {
      title: "t2",
      body: "totally unrelated content with no overlap at all here",
      type: "decision",
    });
    expect(hit).toBeNull();
  });
});

describe("handleMemorySave", () => {
  it("saves and returns the id", async () => {
    const res = await handleMemorySave(store, { type: "decision", title: "T", body: "B" });
    expect(res.details.id).toMatch(/^mem-/);
  });

  it("rejects secrets", async () => {
    const res = await handleMemorySave(store, { type: "fact", title: "T", body: "key sk-abcdefghijklmnop123456" });
    expect(res.details.saved).toBe(false);
    expect(res.details.reason).toMatch(/secret/i);
  });

  it("returns existing id on dedup hit", async () => {
    const first = await handleMemorySave(store, { type: "decision", title: "Same Title", body: "b" });
    const second = await handleMemorySave(store, { type: "decision", title: "same title", body: "b" });
    expect(second.details.id).toBe(first.details.id);
    expect(second.details.duplicate).toBe(true);
  });
});

describe("handleMemorySearch", () => {
  it("ranks title hits above body hits and returns lines only", async () => {
    await store.save({ type: "fact", title: "pnpm filters", body: "unrelated words" });
    await store.save({ type: "fact", title: "docker notes", body: "mentions pnpm once" });
    const res = await handleMemorySearch(store, { query: "pnpm" });
    const text = res.content[0].text as string;
    expect(text.indexOf("pnpm filters")).toBeLessThan(text.indexOf("docker notes"));
    expect(text).not.toContain("unrelated words"); // bodies never returned
  });

  it("respects type and limit filters", async () => {
    await store.save({ type: "fact", title: "fact about pnpm", body: "x" });
    await store.save({ type: "lesson", title: "lesson about pnpm", body: "y" });
    const res = await handleMemorySearch(store, { query: "pnpm", type: "lesson", limit: 10 });
    expect(res.content[0].text).toContain("lesson about pnpm");
    expect(res.content[0].text).not.toContain("fact about pnpm");
  });
});

describe("handleMemoryRead", () => {
  it("returns body and bumps usage", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "the body text" });
    const res = await handleMemoryRead(store, { ids: [saved.id] });
    expect(res.content[0].text).toContain("the body text");
    expect((await store.get(saved.id))?.useCount).toBe(1);
  });
});

describe("handleMemoryForget", () => {
  it("archives the memory", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "b" });
    const res = await handleMemoryForget(store, { id: saved.id });
    expect(res.details.forgotten).toBe(true);
    expect(await store.get(saved.id)).toBeUndefined();
  });
});
