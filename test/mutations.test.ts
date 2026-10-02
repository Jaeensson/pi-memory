import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownStore } from "../src/store.js";
import { handleMemoryForget, handleMemorySave, handleMemoryVerify } from "../src/tools.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-mutations-"));
  roots.push(root);
  const store = new MarkdownStore(root, "project");
  await store.init();
  return { root, store };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("mutation safety", () => {
  it("serializes complete save dedup and supersession", async () => {
    const { store } = await setup();
    const params = { type: "fact" as const, title: "One durable fact", body: "The atomic cache preserves all records between restarts." };
    const results = await Promise.all([handleMemorySave(store, params), handleMemorySave(store, params)]);
    expect((await store.all()).length).toBe(1);
    expect(results.filter((r) => (r.details as any).saved).length).toBe(1);
    expect(results.filter((r) => (r.details as any).duplicate).length).toBe(1);
  });

  it("cancels a queued mutation without entering it after the queue releases", async () => {
    const { store } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holding = store.withMutation(async () => { entered(); await blocker; });
    await ready;
    const controller = new AbortController();
    let ran = false;
    let subscribed!: () => void;
    const listening = new Promise<void>((resolve) => { subscribed = resolve; });
    const addListener = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
      addListener(...args);
      subscribed();
    };
    const queued = store.withMutation(async () => { ran = true; }, controller.signal);
    const outcome = queued.then(() => "resolved", () => "cancelled");
    // Cancel only after this operation is actually waiting on the occupied queue.
    await listening;
    controller.abort(new Error("cancelled"));
    const beforeRelease = await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve("still queued"), 50))]);
    release();
    await holding;
    await outcome;
    expect(beforeRelease).toBe("cancelled");
    expect(ran).toBe(false);
  });

  it("does not detach or release a mutation that has already started when cancelled", async () => {
    const { store } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new AbortController();
    let completed = false;
    const running = store.withMutation(async () => {
      entered();
      await blocker;
      await store.save({ type: "fact", title: "Completed mutation", body: "Finished before the lock released." });
      completed = true;
    }, controller.signal);
    await ready;
    controller.abort(new Error("cancelled"));
    let returned = false;
    const observed = running.finally(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await observed;
    expect(completed).toBe(true);
    expect(await store.all()).toHaveLength(1);
  });

  it("does not lose concurrent usage increments", async () => {
    const { store } = await setup();
    const file = await store.save({ type: "fact", title: "Counter", body: "Usage counts are durable." });
    await Promise.all(Array.from({ length: 12 }, () => store.bumpUsage([file.id])));
    expect((await store.get(file.id))?.useCount).toBe(12);
  });

  it("does not let verification resurrect a concurrently archived memory", async () => {
    const { store } = await setup();
    const file = await store.save({ type: "fact", title: "Archive safely", body: "Forget and verify must coordinate." });
    await Promise.all([
      handleMemoryForget(store, { id: file.id, reason: "replaced", supersededBy: "mem-12345678" }),
      handleMemoryVerify(store, { id: file.id, anchor: "src/store.ts:1" }),
    ]);
    expect(await store.get(file.id)).toBeUndefined();
    const archived = await store.list("project", { includeArchive: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe("superseded");
    expect(archived[0].supersededBy).toBe("mem-12345678");
  });

  it("holds a shared root queue across stores and symlink aliases, with reentrant nesting and recovery", async () => {
    const { root, store } = await setup();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias, "dir");
    const second = new MarkdownStore(alias, "project");
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let firstEntered!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = store.withMutation(async () => {
      started.push("first");
      firstEntered();
      await store.withMutation(async () => { await blocker; });
      throw new Error("expected failure");
    });
    await firstReady;
    const queued = second.withMutation(async () => { started.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["first"]);
    release();
    await expect(first).rejects.toThrow("expected failure");
    await queued;
    expect(started).toEqual(["first", "second"]);
    await second.withMutation(async () => second.save({ type: "fact", title: "Recovered", body: "Queue releases after errors." }));
    expect((await store.all()).map((f) => f.title)).toEqual(["Recovered"]);
  });
});
