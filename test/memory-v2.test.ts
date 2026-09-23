import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { applyOps } from "../src/consolidate.js";
import { gatherInjection } from "../src/inject.js";
import {
  MarkdownStore,
  isActive,
  parseMemoryFile,
  serializeMemoryFile,
  statusOf,
} from "../src/store.js";
import {
  handleMemoryForget,
  handleMemoryList,
  handleMemorySave,
  handleMemorySearch,
  handleMemoryVerify,
} from "../src/tools.js";

let store: MarkdownStore;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pimem-v2-"));
  store = new MarkdownStore(root, "v2proj");
  await store.init();
});

const base = () => ({
  id: "mem-a1b2c3d4",
  type: "decision" as const,
  title: "Use pnpm workspace filters for test runs",
  created: "2026-09-08T09:00:00.000Z",
  lastUsed: "2026-09-08T09:00:00.000Z",
  useCount: 0,
  strength: 0.5,
  scope: "project" as const,
  pinned: false,
  revision: 0,
  previousTitles: [],
  body: "Filter to the touched workspace to keep CI under 5 minutes.",
});

describe("extended frontmatter", () => {
  it("round-trips supersession, anchor, and verification fields", () => {
    const m = {
      ...base(),
      status: "superseded" as const,
      supersedes: ["mem-11111111"],
      supersededBy: "mem-22222222",
      anchor: "commit 6ba5610",
      verifiedAt: "2026-09-20T08:00:00.000Z",
    };
    expect(parseMemoryFile(serializeMemoryFile(m), "project")).toEqual(m);
  });

  it("preserves unknown frontmatter fields through a read/write round-trip", () => {
    const raw = serializeMemoryFile(base()).replace(
      "previousTitles: []",
      'previousTitles: []\nfutureField: {"a":1}',
    );
    const parsed = parseMemoryFile(raw, "project")!;
    expect(parsed.extra).toEqual({ futureField: { a: 1 } });
    const again = parseMemoryFile(serializeMemoryFile(parsed), "project")!;
    expect(again.extra).toEqual({ futureField: { a: 1 } });
  });

  it("treats an absent status as active (legacy files)", () => {
    const parsed = parseMemoryFile(serializeMemoryFile(base()), "project")!;
    expect(statusOf(parsed)).toBe("active");
    expect(isActive(parsed)).toBe(true);
  });

  it("treats a snapshot past its expiresAfter as inactive", () => {
    const past = { ...base(), type: "snapshot" as const, anchor: "file:line", expiresAfter: "2000-01-01T00:00:00.000Z" };
    const future = { ...base(), type: "snapshot" as const, anchor: "file:line", expiresAfter: "2999-01-01T00:00:00.000Z" };
    expect(isActive(past)).toBe(false);
    expect(isActive(future)).toBe(true);
  });

  it("round-trips expiresAfter on a snapshot", () => {
    const m = { ...base(), type: "snapshot" as const, anchor: "commit abc", expiresAfter: "2026-10-01T00:00:00.000Z" };
    expect(parseMemoryFile(serializeMemoryFile(m), "project")).toEqual(m);
  });
});

describe("P0-1 supersession", () => {
  it("marks the target superseded and keeps the file for audit", async () => {
    const old = await handleMemorySave(store, { type: "decision", title: "Old call", body: "old" });
    const neu = await handleMemorySave(store, {
      type: "decision",
      title: "New call",
      body: "new",
      supersedes: [old.details.id as string],
    });
    expect(neu.details.saved).toBe(true);

    const oldFile = await store.get(old.details.id as string);
    expect(oldFile).toBeDefined(); // not archived
    expect(oldFile?.status).toBe("superseded");
    expect(oldFile?.supersededBy).toBe(neu.details.id);

    const newFile = await store.get(neu.details.id as string);
    expect(newFile?.supersedes).toEqual([old.details.id]);
  });

  it("keeps superseded entries out of the generated index and injection", async () => {
    const old = await handleMemorySave(store, { type: "decision", title: "Community images", body: "old" });
    const neu = await handleMemorySave(store, {
      type: "decision",
      title: "Own images",
      body: "new",
      supersedes: [old.details.id as string],
    });
    const lines = await store.indexLines("project");
    expect(lines.some((l) => l.includes(old.details.id as string))).toBe(false);
    expect(lines.some((l) => l.includes(neu.details.id as string))).toBe(true);

    const input = await gatherInjection(store, DEFAULT_CONFIG);
    expect(input.projectIndex.join("\n")).not.toContain(old.details.id as string);
  });

  it("records a reason when forgetting, and an optional forward link", async () => {
    const old = await store.save({ type: "decision", title: "gone", body: "b" });
    const res = await handleMemoryForget(store, {
      id: old.id,
      reason: "replaced by the new plan",
      supersededBy: "mem-12345678",
    });
    expect(res.details.forgotten).toBe(true);
    expect(await store.get(old.id)).toBeUndefined();
    const names = await readdir(store.archiveDir("project"));
    const reasonFile = names.find((n) => n.startsWith(".reason-"))!;
    const content = await readFile(join(store.archiveDir("project"), reasonFile), "utf8");
    expect(content).toContain("replaced by the new plan");
    expect(content).toContain("mem-12345678");
  });
});

describe("P0-2 save-time overlap detection", () => {
  it("saves a heavily-overlapping memory and reports the related id as advisory", async () => {
    const first = await handleMemorySave(store, {
      type: "decision",
      title: "UI personality butler persona light app dark accents",
      body: "design language",
    });
    const second = await handleMemorySave(store, {
      type: "decision",
      title: "UI personality butler persona light app dark accents design",
      body: "design language refined",
    });
    expect(second.details.saved).toBe(true);
    const overlaps = second.details.overlaps as { id: string }[];
    expect(overlaps.some((o) => o.id === first.details.id)).toBe(true);
    expect(second.content[0].text).toMatch(/related/i);
    // The advisory must steer to selective retirement, not blanket supersedes
    // and not another resave (which would duplicate the new memory).
    expect(second.content[0].text).toMatch(/memory_forget/);
    expect(second.content[0].text).toMatch(/supersededBy/);
  });

  it("never blocks a save that only shares domain vocabulary with unrelated memories", async () => {
    // Regression for the observed retry loop: same-domain memories make nearly
    // every new save score above the old block threshold, and each rephrase
    // matched a different set. All of these must save on the first attempt.
    await handleMemorySave(store, {
      type: "lesson",
      title: "amd64 is not a priority; amd64-only build/test targets",
      body: "arm64 is not a priority for image builds",
    });
    await handleMemorySave(store, {
      type: "lesson",
      title: "Image strategy: community images as base plus an image contract",
      body: "no fully custom Dockerfiles",
    });
    await handleMemorySave(store, {
      type: "lesson",
      title: "Valheim image published and pre-pulled on node, awaiting server recreation",
      body: "image pull happens during provision",
    });
    const res = await handleMemorySave(store, {
      type: "lesson",
      title: "Mac arm64 cannot run the amd64 game server image locally",
      body: "CI smoke tests pass on amd64; only this arm64 Mac fails, so test image changes in CI.",
    });
    expect(res.details.saved).toBe(true);
    expect(res.content[0].text).not.toMatch(/not saved/i);
  });

  it("still saves genuinely distinct memories", async () => {
    await handleMemorySave(store, { type: "fact", title: "docker bind mounts uid", body: "run as uid 1000" });
    const res = await handleMemorySave(store, {
      type: "fact",
      title: "svelte form validation",
      body: "zod schemas shared with the api",
    });
    expect(res.details.saved).toBe(true);
  });
});

describe("P0-3 verification and P2-7 snapshots", () => {
  it("memory_verify stamps verifiedAt (and records an anchor)", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "b" });
    const res = await handleMemoryVerify(store, { id: saved.id, anchor: "crates/x.rs:12" });
    expect(res.details.verified).toBe(true);
    const got = await store.get(saved.id);
    expect(got?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(got?.anchor).toBe("crates/x.rs:12");
  });

  it("requires anchor and expiresAfter for snapshots", async () => {
    const bad = await handleMemorySave(store, { type: "snapshot", title: "count", body: "98 tests" });
    expect(bad.details.saved).toBe(false);
    expect(bad.details.reason).toMatch(/anchor|expiresAfter/);
    const good = await handleMemorySave(store, {
      type: "snapshot",
      title: "test count",
      body: "98 tests at this commit",
      anchor: "commit 46fd329",
      expiresAfter: "2026-10-20T00:00:00.000Z",
    });
    expect(good.details.saved).toBe(true);
  });

  it("excludes an expired snapshot from injection", async () => {
    const snap = await handleMemorySave(store, {
      type: "snapshot",
      title: "old count",
      body: "54 tests",
      anchor: "commit fc445c2",
      expiresAfter: "2000-01-01T00:00:00.000Z",
    });
    expect(snap.details.saved).toBe(true);
    const input = await gatherInjection(store, DEFAULT_CONFIG);
    expect(input.projectIndex.join("\n")).not.toContain(snap.details.id as string);
  });
});

describe("P1-4 memory_list and P1-5 pinned", () => {
  it("pages the store without reading files off disk", async () => {
    for (let i = 0; i < 3; i++) await store.save({ type: "fact", title: `m${i}`, body: "b" });
    const res = await handleMemoryList(store, { scope: "project", limit: 2, offset: 1 });
    expect(res.details.total).toBe(3);
    const lines = (res.content[0].text as string).split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(2);
  });

  it("marks effective status, including expired snapshots", async () => {
    await store.save({ type: "fact", title: "live", body: "b" });
    const expired = await store.save({
      type: "snapshot",
      title: "old",
      body: "b",
      anchor: "x",
      expiresAfter: "2000-01-01T00:00:00.000Z",
    });
    const res = await handleMemoryList(store, { scope: "project", status: "expired" });
    expect(res.content[0].text).toContain(expired.id);
  });

  it("memory_save exposes pinned", async () => {
    const res = await handleMemorySave(store, { type: "lesson", title: "pin me", body: "b", pinned: true });
    const got = await store.get(res.details.id as string);
    expect(got?.pinned).toBe(true);
  });
});

describe("search demotes superseded entries", () => {
  it("ranks an active entry above a superseded one for the same term", async () => {
    const old = await store.save({ type: "fact", title: "widget alpha", body: "widget" });
    const neu = await handleMemorySave(store, {
      type: "fact",
      title: "widget beta",
      body: "widget",
      supersedes: [old.id],
    });
    const res = await handleMemorySearch(store, { query: "widget" });
    const text = res.content[0].text as string;
    // inactive entries stay searchable for audit but sort below every active hit
    expect(text).toContain(old.id);
    expect(text).toContain(neu.details.id as string);
    expect(text.indexOf(neu.details.id as string)).toBeLessThan(text.indexOf(old.id));
    expect(text).toContain("[superseded");
  });
});

describe("review fixes", () => {
  it("consolidation refuses snapshot ADDs (its op schema carries no anchor/expiresAfter)", async () => {
    const applied = await applyOps(
      store,
      [{ op: "ADD", type: "snapshot", title: "count", body: "98 tests", scope: "project", confidence: 0.95 }],
      { maxOpsPerRun: 12 },
      new Date("2026-09-20T00:00:00.000Z"),
    );
    expect(applied.added).toHaveLength(0);
    expect(applied.skipped).toBe(1);
    expect(applied.notes.join(" ")).toMatch(/snapshot/i);
  });

  it("corruptCount is stable across repeated reads", async () => {
    await store.save({ type: "fact", title: "ok", body: "b" });
    await writeFile(join(store.scopeDir("project"), "mem-badf00d0.md"), "corrupt", "utf8");
    await store.all();
    await store.activeIndexLines("project");
    await store.all();
    await store.activeIndexLines("project");
    expect(store.corruptCount).toBe(1);
  });

  it("store.update preserves unknown frontmatter fields", async () => {
    const saved = await store.save({ type: "fact", title: "T", body: "b" });
    const path = join(store.scopeDir("project"), `${saved.id}.md`);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("previousTitles: []", 'previousTitles: []\nfutureField: "keep me"'), "utf8");
    const loaded = (await store.get(saved.id))!;
    expect(loaded.extra).toEqual({ futureField: "keep me" });
    loaded.body = "updated";
    await store.update(loaded);
    expect((await store.get(saved.id))?.extra).toEqual({ futureField: "keep me" });
  });

  it("reports a weak overlap in the success message, not only in details", async () => {
    await handleMemorySave(store, { type: "fact", title: "docker deployment notes", body: "alpha" });
    const res = await handleMemorySave(store, { type: "fact", title: "docker networking handbook", body: "beta" });
    expect(res.details.saved).toBe(true);
    expect(res.content[0].text).toMatch(/related/i);
  });

  it("normalizes bare supersedes ids before storing and resolving them", async () => {
    const old = await store.save({ type: "fact", title: "old fact", body: "b" });
    const res = await handleMemorySave(store, {
      type: "decision",
      title: "new decision",
      body: "b",
      supersedes: [old.id.slice("mem-".length)],
    });
    expect(res.details.saved).toBe(true);
    expect((await store.get(old.id))?.status).toBe("superseded");
    expect((await store.get(res.details.id as string))?.supersedes).toEqual([old.id]);
  });
});
