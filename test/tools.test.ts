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
    ["PASSWORD> hunter2secret", "assignment"],
    ["AAAAcHJldGVuZGVkLWxvbmctYmFzZTY0LWJsb2JiYXR0ZWhjb2Rl", "base64"],
    ["deadbeefdeadbeefdeadbeefdeadbeef1", "hex"],
  ])("rejects %s", (text) => {
    expect(secretScan(text).ok).toBe(false);
  });

  it("allows normal prose", () => {
    expect(secretScan("We chose pnpm because workspaces are faster.").ok).toBe(true);
  });

  it("allows a full git hash cited as evidence", () => {
    expect(secretScan("Fixed in commit 6ef69f3a1b2c3d4e5f60718293a4b5c6d7e8f901.").ok).toBe(true);
    expect(secretScan(`content hash ${"a".repeat(64)}`).ok).toBe(true);
  });

  it("still rejects a non-hash hex blob", () => {
    expect(secretScan("token deadbeefdeadbeefdeadbeefdeadbeef").ok).toBe(false);
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

  it("flags shared 8-word sequence spanning punctuation in stored body", async () => {
    await store.save({
      type: "lesson",
      title: "held",
      body: "alpha beta gamma, delta epsilon\nzeta eta theta",
    });
    const hit = await dedupCheck(store, {
      title: "unrelated",
      body: "alpha beta gamma delta epsilon zeta eta theta repeated",
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

describe("handleMemorySearch relevance", () => {
  const textOf = (res: { content: { text: string }[] }) => res.content[0].text;

  it("matches morphological variants via stem prefixes (archiving → archival)", async () => {
    await store.save({
      type: "fact",
      title: "strength decay: weak memories are archival after 30 days",
      body: "unrelated words here",
    });
    const res = await handleMemorySearch(store, { query: "archiving" });
    expect(textOf(res)).toContain("archival after 30 days");
  });

  it("matches verb forms against base forms (retrying → retry)", async () => {
    await store.save({ type: "lesson", title: "test runner needs retry for flaky suites", body: "x" });
    const res = await handleMemorySearch(store, { query: "retrying tests" });
    expect(textOf(res)).toContain("retry for flaky suites");
  });

  it("tolerates one-character typos in longer terms", async () => {
    await store.save({
      type: "fact",
      title: "consolidation watermark resumes after restart",
      body: "unrelated words here",
    });
    const res = await handleMemorySearch(store, { query: "conslidation" });
    expect(textOf(res)).toContain("consolidation watermark");
  });

  it("does not fuzzy-match short terms (coe ↛ core)", async () => {
    await store.save({ type: "fact", title: "core loop design", body: "y" });
    const res = await handleMemorySearch(store, { query: "coe" });
    expect(textOf(res)).toContain("No matching memories");
  });

  it("requires two edits to exceed typo tolerance (test ↛ toast)", async () => {
    await store.save({ type: "fact", title: "toast notification settings", body: "y" });
    const res = await handleMemorySearch(store, { query: "test" });
    expect(textOf(res)).toContain("No matching memories");
  });

  it("tolerates one-character typos in body-only terms", async () => {
    await store.save({
      type: "fact",
      title: "unrelated title words only",
      body: "the consolidation watermark advances after each run",
    });
    const res = await handleMemorySearch(store, { query: "conslidation" });
    expect(textOf(res)).toContain("unrelated title words only");
  });

  it("does not substring-match inside unrelated words (test ↛ fastest)", async () => {
    await store.save({ type: "fact", title: "fastest CI pipeline", body: "protest banners everywhere" });
    const res = await handleMemorySearch(store, { query: "test" });
    expect(textOf(res)).toContain("No matching memories");
  });

  it("matches word starts with sufficient prefix (auth → authenticated)", async () => {
    await store.save({ type: "fact", title: "websocket uses authenticated sessions", body: "y" });
    const res = await handleMemorySearch(store, { query: "auth websocket" });
    expect(textOf(res)).toContain("authenticated sessions");
  });

  it("finds memories by their previous (superseded) titles", async () => {
    const saved = await store.save({
      type: "decision",
      title: "deploy runs via GitHub Actions",
      body: "workflow triggers on release tags",
    });
    const file = (await store.get(saved.id))!;
    file.title = "deploy runs via a dedicated runner";
    file.previousTitles = ["deploy via bare git push to droplet"];
    await store.update(file);
    const res = await handleMemorySearch(store, { query: "bare droplet push" });
    expect(textOf(res)).toContain("deploy runs via a dedicated runner");
  });

  it("ignores body-only hits for terms common across the store (noise gate)", async () => {
    await store.save({ type: "fact", title: "rust backend", body: "the server handles requests" });
    await store.save({ type: "fact", title: "sveltekit frontend", body: "the server sends events" });
    await store.save({ type: "fact", title: "game templates", body: "the server config lives elsewhere" });
    const res = await handleMemorySearch(store, { query: "server" });
    expect(textOf(res)).toContain("No matching memories");
  });

  it("keeps body-only hits for rare terms", async () => {
    await store.save({ type: "fact", title: "rust backend", body: "hashing uses argon2id parameters" });
    await store.save({ type: "fact", title: "sveltekit frontend", body: "form validation is zod-based" });
    await store.save({ type: "fact", title: "game templates", body: "templates are config not code" });
    const res = await handleMemorySearch(store, { query: "argon2id hashing" });
    expect(textOf(res)).toContain("rust backend");
  });

  it("breaks score ties by strength", async () => {
    const first = await store.save({ type: "fact", title: "alpha note", body: "b" });
    await store.save({ type: "fact", title: "omega note", body: "b" });
    const file = (await store.get(first.id))!;
    file.strength = 0.9;
    await store.update(file);
    const res = await handleMemorySearch(store, { query: "note" });
    const text = textOf(res);
    expect(text.indexOf("alpha note")).toBeLessThan(text.indexOf("omega note"));
  });
});

describe("handleMemoryRead", () => {
  it("returns body and bumps usage", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "the body text" });
    const res = await handleMemoryRead(store, { ids: [saved.id] });
    expect(res.content[0].text).toContain("the body text");
    expect((await store.get(saved.id))?.useCount).toBe(1);
  });

  it("reads a memory when the id omits the mem- prefix", async () => {
    // Models sometimes pass only the 8 hex chars; the tool must still resolve it.
    const saved = await store.save({ type: "fact", title: "T", body: "the body text" });
    const res = await handleMemoryRead(store, { ids: [saved.id.slice("mem-".length)] });
    expect(res.content[0].text).toContain("the body text");
    expect(res.content[0].text).toContain(saved.id);
  });
});

describe("handleMemoryForget", () => {
  it("archives the memory", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "b" });
    const res = await handleMemoryForget(store, { id: saved.id });
    expect(res.details.forgotten).toBe(true);
    expect(await store.get(saved.id)).toBeUndefined();
  });

  it("archives when the id omits the mem- prefix", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "b" });
    const res = await handleMemoryForget(store, { id: saved.id.slice("mem-".length) });
    expect(res.details.forgotten).toBe(true);
    expect(await store.get(saved.id)).toBeUndefined();
  });
});
