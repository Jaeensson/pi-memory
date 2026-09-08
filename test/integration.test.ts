import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runConsolidation, type SessionEntryLike } from "../src/consolidate.js";
import { gatherInjection, renderMemoryBlock } from "../src/inject.js";
import { MarkdownStore } from "../src/store.js";
import { handleMemoryRead, handleMemorySave } from "../src/tools.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
let store: MarkdownStore;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pimem-"));
  store = new MarkdownStore(root, "intproj");
  await store.init();
});

const entries: SessionEntryLike[] = [
  { id: "e1", type: "message", message: { role: "user", content: "Decision: we use SQLite for the cache because we do not want a daemon." } },
  { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Got it." }] } },
];

it("session 1: explicit save appears in the next injection", async () => {
  const saved = await handleMemorySave(store, {
    type: "decision",
    title: "Cache uses SQLite",
    body: "No daemon wanted; embedded keeps ops simple.",
  });
  expect(saved.details.saved).toBe(true);
  const input = await gatherInjection(store, DEFAULT_CONFIG);
  const block = renderMemoryBlock(input, DEFAULT_CONFIG);
  expect(block.text).toContain("Cache uses SQLite");
});

it("consolidation extracts a decision; session 2 injection shows it; read bumps usage", async () => {
  const complete = async () =>
    JSON.stringify([
      {
        op: "ADD",
        type: "decision",
        title: "Cache uses SQLite, not Redis",
        body: "User rejected a daemon dependency; embedded SQLite keeps deployment simple.",
        scope: "project",
        confidence: 0.95,
      },
    ]);
  const res = await runConsolidation(store, entries, { complete, cfg: DEFAULT_CONFIG, sessionId: "s1", now: NOW });
  expect(res.ok).toBe(true);
  expect(res.applied?.added).toHaveLength(1);

  const block = renderMemoryBlock(await gatherInjection(store, DEFAULT_CONFIG), DEFAULT_CONFIG);
  expect(block.text).toContain("Cache uses SQLite, not Redis");

  const id = res.applied!.added[0]!;
  await handleMemoryRead(store, { ids: [id] });
  const mem = await store.get(id);
  expect(mem?.useCount).toBe(1); // reinforcement via read; strength itself recomputes at the next consolidation
});

it("contradiction is resolved via UPDATE with provenance", async () => {
  const seed = await store.save({ type: "decision", title: "Cache uses Redis", body: "Chosen for speed." });
  const complete = async () =>
    JSON.stringify([
      { op: "UPDATE", targetId: seed.id, body: "Switched to SQLite — no daemon wanted.", reason: "user changed stack" },
    ]);
  const res = await runConsolidation(store, entries, { complete, cfg: DEFAULT_CONFIG, sessionId: "s1", now: NOW });
  expect(res.applied?.updated).toEqual([seed.id]);
  const mem = await store.get(seed.id);
  expect(mem?.title).toBe("Cache uses Redis"); // title unchanged
  expect(mem?.body).toContain("SQLite");
  expect(mem?.revision).toBe(1);
});

it("secret in a consolidation ADD is rejected, rest of the batch applies", async () => {
  const complete = async () =>
    JSON.stringify([
      { op: "ADD", type: "fact", title: "good", body: "fine fact", scope: "project", confidence: 0.9 },
      { op: "ADD", type: "fact", title: "leak", body: "key sk-abcdefghijklmnop123456", scope: "project", confidence: 0.9 },
    ]);
  const res = await runConsolidation(store, entries, { complete, cfg: DEFAULT_CONFIG, sessionId: "s1", now: NOW });
  expect(res.applied?.added).toHaveLength(1);
  expect(res.applied?.skipped).toBe(1);
});

it("prune: old weak unpinned memory disappears from injection after decay run", async () => {
  const old = await store.save({ type: "fact", title: "stale thing", body: "b" });
  const oldDate = new Date(NOW.getTime() - 40 * 86400000);
  const file = await store.get(old.id);
  file!.lastUsed = oldDate.toISOString();
  await store.update(file!);

  // Consolidation with nothing new still decays/prunes.
  const wmEntries: SessionEntryLike[] = [{ id: "e2", type: "message", message: { role: "user", content: "hi" } }];
  const complete = async () => "[]";
  const res = await runConsolidation(store, wmEntries, { complete, cfg: DEFAULT_CONFIG, sessionId: "s1", now: NOW });
  expect(res.ok).toBe(true);
  expect(await store.get(old.id)).toBeUndefined();
  const block = renderMemoryBlock(await gatherInjection(store, DEFAULT_CONFIG), DEFAULT_CONFIG);
  expect(block.text).not.toContain("stale thing");
});
