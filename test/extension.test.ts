import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createHarness, response } from "./extension-harness.js";
import { WatermarkStore } from "../src/consolidate.js";
import { formatMemoryLabel } from "../src/commands.js";

const homes: string[] = [];
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const app = await createHarness(options);
  homes.push(app.home);
  return app;
}

describe("memory storage roots", () => {
  it("writes only inside the explicitly selected agent directory", async () => {
    const app = await harness({ customAgentDir: true });
    await app.emit("session_start");
    await app.execute("memory_save", { type: "fact", title: "Custom profile fact", body: "Kept in this profile only." });
    expect((await app.store.all()).map((f) => f.title)).toEqual(["Custom profile fact"]);
    await expect(lstat(join(app.home, ".pi", "agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("follows the intentional default-store symlink without replacing or moving it", async () => {
    const app = await harness({ prepare: async (home) => {
      await mkdir(join(home, ".pi", "agent"), { recursive: true });
      await mkdir(join(home, "shared-memory"));
      await symlink(join(home, "shared-memory"), join(home, ".pi", "agent", "memory"), "dir");
    } });
    await app.emit("session_start");
    const saved = await app.execute("memory_save", { type: "fact", title: "Synced fact", body: "Shared across devices." });
    expect((await lstat(app.root)).isSymbolicLink()).toBe(true);
    const path = join(app.home, "shared-memory", "projects", app.store.projectSlug, `${(saved.details as any).id}.md`);
    expect(await readFile(path, "utf8")).toContain("Shared across devices.");
  });
});

describe("prompt and consolidation integration", () => {
  it("injects a named prompt section without forcing a complete prompt replacement", async () => {
    const app = await harness();
    await app.emit("session_start");
    await app.execute("memory_save", { type: "fact", title: "Pinned fact", body: "PINNED_RULE", pinned: true });
    vi.useFakeTimers();
    const options = { cwd: app.cwd, sections: { existing: "Existing instructions" } };
    const result = await app.emit("before_agent_start", { systemPrompt: "BASE", systemPromptOptions: options });
    expect(result).toBeUndefined();
    expect(options.sections).toMatchObject({ existing: "Existing instructions", memory: expect.stringContaining("PINNED_RULE") });
  });

  it.each(["error", "aborted", "length", "toolUse", "pending", "deferred"] as const)("does not advance the watermark after a %s model response", async (stopReason) => {
    const app = await harness();
    await app.emit("session_start");
    app.sessionManager.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
    app.setCompletion(async () => response("[]", stopReason));
    vi.useFakeTimers();
    await app.emit("session_shutdown");
    expect((await new WatermarkStore(app.store.scopeDir("project")).read()).lastEntryId).toBeNull();
    expect(app.notifications.some((n) => n.level === "warning" && /consolidation failed/.test(n.message))).toBe(true);
  });

  it("forwards the session id so opencode-go routing accepts consolidation", async () => {
    const app = await harness();
    await app.emit("session_start");
    app.sessionManager.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
    let seenOptions: { sessionId?: unknown; cacheRetention?: unknown } | undefined;
    const inner = app.ctx.modelRegistry.streamSimple;
    (app.ctx.modelRegistry as any).streamSimple = (model: unknown, context: unknown, options?: any) => {
      seenOptions = options;
      return (inner as any)(model, context, options);
    };
    app.setCompletion(async () => response("[]"));
    vi.useFakeTimers();
    await app.emit("session_shutdown");
    expect(seenOptions?.sessionId).toBe(app.sessionManager.getSessionId());
    expect(seenOptions?.cacheRetention).toBe("none");
  });

  it("extracts memories through the provider-neutral model path", async () => {
    const app = await harness();
    await app.emit("session_start");
    app.sessionManager.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
    app.setCompletion(async () => response(JSON.stringify([{ op: "ADD", type: "decision", title: "Embedded cache", body: "Avoids a daemon.", scope: "project", confidence: 0.9 }])));
    // The API-specific path cannot dispatch a virtual selection; model work must use streamSimple.
    app.ctx.modelRegistry.complete = async () => response("", "error");
    vi.useFakeTimers();
    await app.emit("session_shutdown");
    expect((await app.store.all()).map((f) => f.title)).toEqual(["Embedded cache"]);
    expect((await new WatermarkStore(app.store.scopeDir("project")).read()).lastEntryId).not.toBeNull();
  });
});

describe("consolidation lifecycle", () => {
  it("aborts timed-out model work even when the provider ignores cancellation, without late writes", async () => {
    const app = await harness();
    await app.emit("session_start");
    app.sessionManager.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
    let release!: (value: ReturnType<typeof response>) => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    app.setCompletion(async (received) => { signal = received; entered(); return pending; });
    vi.useFakeTimers();
    const shutdown = app.emit("session_shutdown");
    await ready;
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    expect(signal?.aborted).toBe(true);
    release(response(JSON.stringify([{ op: "ADD", type: "fact", title: "Late write", body: "Must not be persisted.", scope: "project", confidence: 0.9 }])));
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(await app.store.all()).toEqual([]);
    expect((await new WatermarkStore(app.store.scopeDir("project")).read()).lastEntryId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an already running consolidation and does not leave its grace timer behind", async () => {
    const app = await harness();
    await app.emit("session_start");
    app.sessionManager.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
    let release!: (value: ReturnType<typeof response>) => void;
    let entered!: () => void;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    app.setCompletion(async () => { entered(); return pending; });
    vi.useFakeTimers();
    await app.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(60000);
    await ready;
    let returned = false;
    const shutdown = app.emit("session_shutdown").then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(0);
    const returnedBeforeCompletion = returned;
    release(response(JSON.stringify([{ op: "ADD", type: "decision", title: "Awaited extraction", body: "Completed before shutdown returned.", scope: "project", confidence: 0.9 }])));
    await shutdown;
    await vi.waitFor(async () => expect((await app.store.all()).map((f) => f.title)).toEqual(["Awaited extraction"]));
    expect(returnedBeforeCompletion).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the shutdown grace timer when extraction finishes promptly", async () => {
    const app = await harness();
    await app.emit("session_start");
    vi.useFakeTimers();
    await app.emit("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("storage error recovery", () => {
  it("re-enables writes on the next session after a storage error", async () => {
    const { chmod } = await import("node:fs/promises");
    const app = await harness();
    await app.emit("session_start");
    const projectDir = join(app.root, "projects", app.store.projectSlug);
    await chmod(projectDir, 0o555);
    await expect(app.execute("memory_save", { type: "fact", title: "blocked", body: "b" })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(app.notifications.some((n) => n.level === "error" && /writes disabled/.test(n.message))).toBe(true);
    await chmod(projectDir, 0o755);
    await app.emit("session_start");
    const saved = await app.execute("memory_save", { type: "fact", title: "allowed", body: "b" });
    expect((saved.details as { saved?: boolean }).saved).toBe(true);
  });
});

describe("command mutations after asynchronous dialogs", () => {
  it.each(["View / edit body", "Pin (always inject)"])("preserves concurrent verification when applying %s", async (action) => {
    const app = await harness();
    await app.emit("session_start");
    const file = await app.store.save({ type: "fact", title: "Editable fact", body: "Original body." });
    let release!: (value: string) => void;
    let entered!: () => void;
    const dialog = new Promise<string>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    app.ui.select.mockResolvedValueOnce(formatMemoryLabel(file));
    if (action === "View / edit body") {
      app.ui.select.mockResolvedValueOnce(action);
      app.ui.editor.mockImplementationOnce(async () => { entered(); return dialog; });
    } else {
      app.ui.select.mockImplementationOnce(async () => { entered(); return dialog; });
    }
    const command = app.commands.get("memory")!.handler("", app.ctx as any);
    await ready;
    await app.execute("memory_verify", { id: file.id, anchor: "verified:1" });
    release(action === "View / edit body" ? "New body." : action);
    await command;
    const updated = await app.store.get(file.id);
    expect(updated?.anchor).toBe("verified:1");
    expect(updated?.verifiedAt).toBeDefined();
    if (action === "View / edit body") expect(updated?.body).toBe("New body.");
    else expect(updated?.pinned).toBe(true);
  });

  it("does not resurrect a memory forgotten while its editor is open", async () => {
    const app = await harness();
    await app.emit("session_start");
    const file = await app.store.save({ type: "fact", title: "Editable fact", body: "Original body." });
    let release!: (value: string) => void;
    let entered!: () => void;
    const dialog = new Promise<string>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    app.ui.select.mockResolvedValueOnce(formatMemoryLabel(file)).mockResolvedValueOnce("View / edit body");
    app.ui.editor.mockImplementationOnce(async () => { entered(); return dialog; });
    const command = app.commands.get("memory")!.handler("", app.ctx as any);
    await ready;
    await app.execute("memory_forget", { id: file.id, reason: "No longer valid" });
    release("Late edit.");
    await command;
    expect(await app.store.get(file.id)).toBeUndefined();
    expect((await app.store.list("project", { includeArchive: true }))).toHaveLength(1);
  });
});

describe("commands without dialog-capable UI", () => {
  it.each(["memory", "memory-preview"])("/%s fails explicitly instead of silently opening a no-op dialog", async (name) => {
    const app = await harness();
    await app.emit("session_start");
    await app.execute("memory_save", { type: "fact", title: "Existing fact", body: "An existing memory." });
    app.ctx.hasUI = false;
    app.ctx.mode = "print";
    await expect(app.commands.get(name)!.handler("", app.ctx as any)).rejects.toThrow(/UI|interactive/i);
    expect(app.ui.select).not.toHaveBeenCalled();
    expect(app.ui.editor).not.toHaveBeenCalled();
  });
});
