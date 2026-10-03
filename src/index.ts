import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig, type MemoryConfig } from "./config.js";
import { registerMemoryCommands } from "./commands.js";
import { gatherInjection, renderMemoryBlock } from "./inject.js";
import {
  runConsolidation,
  type CompleteFn,
  type SessionEntryLike,
} from "./consolidate.js";
import { MarkdownStore } from "./store.js";
import {
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRead,
  handleMemorySave,
  handleMemorySearch,
  handleMemoryVerify,
} from "./tools.js";
import { resolveProjectSlug } from "./store.js";

// Providers may ignore cancellation. Stop awaiting them and detach their late result.
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export default function (pi: ExtensionAPI) {
  // Follow the configured agent directory without replacing existing symlinks.
  const memoryRoot = join(getAgentDir(), "memory");

  let cfg: MemoryConfig | undefined;
  let store: MarkdownStore | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let consolidationPromise: Promise<void> | undefined;
  let consolidationController: AbortController | undefined;
  let shuttingDown = false;
  let writesDisabled = false;

  const updateWidget = async (ctx: ExtensionContext) => {
    if (!store) return;
    const n = (await store.all()).length;
    ctx.ui.setWidget("pi-memory", [n > 0 ? `mem: ${n}` : undefined].filter((l): l is string => l !== undefined));
  };

  const resetIdleTimer = (ctx: ExtensionContext) => {
    if (idleTimer) clearTimeout(idleTimer);
    if (shuttingDown || !cfg?.enabled || !store || !ctx.model) return;
    idleTimer = setTimeout(() => {
      void runConsolidationSafely(ctx).catch(() => {}); // session may have gone stale mid-run
    }, cfg.idleSeconds * 1000);
  };

  // Storage-failure guard (spec §9): notify once, disable writes for the session.
  const guard = (fn: () => Promise<unknown>, ctx: ExtensionContext): Promise<unknown> =>
    fn().catch((err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOSPC" || code === "EROFS") {
        if (!writesDisabled) {
          writesDisabled = true;
          ctx.ui.notify("pi-memory: storage error — writes disabled for this session", "error");
        }
      }
      throw err;
    });

  const makeComplete = (ctx: ExtensionContext, signal: AbortSignal): CompleteFn => {
    // Capture session-bound model state before any asynchronous work.
    const registry = ctx.modelRegistry;
    // opencode/opencode-go route via x-opencode-session; without sessionId the
    // server rejects with 400 MissingSessionID even when caching is disabled.
    const sessionId = ctx.sessionManager.getSessionId();
    let model = ctx.model;
    if (cfg?.consolidationModel) {
      const [providerId, ...rest] = cfg.consolidationModel.split("/");
      model = registry.find(providerId, rest.join("/")) ?? model;
    }
    return async (prompt: string) => {
      signal.throwIfAborted();
      if (!model || !registry.hasConfiguredAuth(model)) {
        throw new Error("no model configured for memory consolidation");
      }
      const response = await abortable(registry.streamSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { cacheRetention: "none", signal, sessionId },
      ).result(), signal);
      if (response.stopReason !== "stop") {
        throw new Error(response.errorMessage ?? `memory consolidation did not finish (${response.stopReason})`);
      }
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    };
  };

  const runConsolidationSafely = async (ctx: ExtensionContext): Promise<void> => {
    if (consolidationPromise) return consolidationPromise;
    if (!store || !cfg || !ctx.model || writesDisabled) return Promise.resolve();
    const activeStore = store;
    const activeConfig = cfg;
    const controller = new AbortController();
    consolidationController = controller;
    consolidationPromise = (async () => {
      let failed = false;
      try {
        const complete = makeComplete(ctx, controller.signal);
        const entries: SessionEntryLike[] = ctx.sessionManager.getBranch().map((e) => ({
          id: e.id,
          type: e.type,
          message: e.type === "message" ? (e.message as SessionEntryLike["message"]) : undefined,
        }));
        const sessionId = ctx.sessionManager.getSessionId() ?? null;
        ctx.ui.setWidget("pi-memory", ["memory: consolidating…"]);
        const result = await runConsolidation(activeStore, entries, {
          complete, cfg: activeConfig, sessionId, now: new Date(), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!result.ok) {
          failed = true;
          ctx.ui.setWidget("pi-memory", ["memory: idle (consolidation failed — will retry)"]);
          ctx.ui.notify(`pi-memory consolidation failed: ${result.reason}`, "warning");
        } else {
          const changed = (result.applied?.added.length ?? 0) + (result.applied?.updated.length ?? 0) + (result.applied?.deleted.length ?? 0) + (result.pruned?.length ?? 0);
          if (changed > 0) ctx.ui.notify(`pi-memory: +${result.applied?.added.length ?? 0} ~${result.applied?.updated.length ?? 0} -${result.applied?.deleted.length ?? 0} pruned ${result.pruned?.length ?? 0}`, "info");
        }
      } catch (err) {
        failed = true;
        if (!controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.setWidget("pi-memory", ["memory: idle (consolidation failed — will retry)"]);
          ctx.ui.notify(`pi-memory consolidation failed: ${msg}`, "warning");
        }
      } finally {
        if (!failed && !controller.signal.aborted) {
          try {
            await updateWidget(ctx);
          } catch {
            // Widget updates are best-effort during session teardown.
          }
        }
      }
    })().finally(() => {
      consolidationPromise = undefined;
      consolidationController = undefined;
    });
    return consolidationPromise;
  };

  pi.on("session_start", async (event, ctx) => {
    shuttingDown = false;
    writesDisabled = false; // a storage error is scoped to one session
    store = undefined; // never carry a prior session's store into this one
    cfg = await loadConfig(memoryRoot);
    if (!cfg.enabled) return;
    const slug = await resolveProjectSlug(ctx.cwd);
    store = new MarkdownStore(memoryRoot, slug, cfg);
    await store.init();
    await store.all(); // populates corruptCount via listDir
    if (store.corruptCount > 0) {
      ctx.ui.notify(
        `pi-memory: ${store.corruptCount} memory file(s) have corrupt frontmatter and were skipped (files kept on disk)`,
        "warning",
      );
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!ctx.model) {
      ctx.ui.setWidget("pi-memory", ["memory: idle (no model)"]);
      return;
    }
    await updateWidget(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!store || !cfg?.enabled) return;
    resetIdleTimer(ctx);
    const block = renderMemoryBlock(await gatherInjection(store, cfg), cfg);
    event.systemPromptOptions.sections.memory = block.text;
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetIdleTimer(ctx); // any new activity resets the idle timer (spec §7.1)
  });

  pi.on("agent_settled", async (_event, ctx) => {
    resetIdleTimer(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    // Await the existing run (or one final run), then cancel if its grace expires.
    const pending = consolidationPromise ?? runConsolidationSafely(ctx);
    const controller = consolidationController;
    const grace = setTimeout(() => controller?.abort(new Error("memory consolidation shutdown timeout")), 5000);
    try {
      await pending;
    } finally {
      clearTimeout(grace);
    }
  });

  const withStore = () => store;

  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description: "Persist a durable project decision, fact, or lesson from a mistake for future sessions",
    promptSnippet: "Save a durable decision/fact/lesson to long-term memory",
    promptGuidelines: [
      "Use memory_save to persist durable project decisions, facts, and lessons from mistakes. Call it immediately when the user corrects your approach — corrections must not wait for later.",
      "When the new memory replaces an existing one, pass its id in supersedes so the old entry is retired (kept on disk for audit) instead of competing for injection — supersede only the memories it actually replaces, never the whole related list. 'Related' ids in the save result are advisory, not blockers; if one is now stale, retire it afterwards with memory_forget (id, supersededBy).",
    ],
    parameters: Type.Object({
      type: StringEnum(["decision", "fact", "lesson", "snapshot"] as const),
      title: Type.String({ description: "One-line specific summary" }),
      body: Type.String({ description: "2-6 sentences including the why" }),
      scope: Type.Optional(StringEnum(["project", "global"] as const)),
      pinned: Type.Optional(Type.Boolean({ description: "Always inject this memory's full body (prohibitions/standing rules)" })),
      supersedes: Type.Optional(
        Type.Array(Type.String(), { description: "Ids this memory replaces; targets are marked superseded" }),
      ),
      anchor: Type.Optional(Type.String({ description: "Cheap evidence: a commit sha, file:line, or 'decision'" })),
      expiresAfter: Type.Optional(
        Type.String({ description: "snapshot only: ISO-8601 UTC time after which the snapshot is stale" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!store) throw new Error("memory store not initialized");
      if (writesDisabled) throw new Error("pi-memory writes disabled after storage error");
      const res = (await guard(() => handleMemorySave(store!, params), ctx)) as ReturnType<typeof handleMemorySave>;
      await updateWidget(ctx);
      return res;
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search saved memories by keyword; returns id/type/title lines only",
    promptSnippet: "Keyword-search the long-term memory store",
    parameters: Type.Object({
      query: Type.String(),
      scope: Type.Optional(StringEnum(["project", "global", "all"] as const)),
      type: Type.Optional(StringEnum(["decision", "fact", "lesson", "snapshot"] as const)),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("memory store not initialized");
      return handleMemorySearch(store, params);
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read full memory contents by id (1-20 ids, e.g. mem-09839b44); the bare 8-hex form is also accepted; bumps usage",
    promptSnippet: "Read full memory entries by id (e.g. mem-09839b44)",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("memory store not initialized");
      return handleMemoryRead(store, params);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Archive a wrong or obsolete memory by id (e.g. mem-09839b44); requires a reason and records an optional forward link",
    promptSnippet: "Archive a memory by id (e.g. mem-09839b44)",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.String({
        description: "Why this memory is being archived (required): the only signal that explains a disappearance",
      }),
      supersededBy: Type.Optional(
        Type.String({ description: "Id of the memory that replaces this one; recorded on the archive" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!store) throw new Error("memory store not initialized");
      if (writesDisabled) throw new Error("pi-memory writes disabled after storage error");
      const res = (await guard(() => handleMemoryForget(store!, params), ctx)) as ReturnType<typeof handleMemoryForget>;
      await updateWidget(ctx);
      return res;
    },
  });

  pi.registerTool({
    name: "memory_verify",
    label: "Memory Verify",
    description:
      "Mark a memory as re-checked against the repo (stamps verifiedAt, optionally records an anchor); verified entries rank above merely-cited ones",
    promptSnippet: "Re-verify a memory against the repo after checking its claim",
    parameters: Type.Object({
      id: Type.String({ description: "Memory id, e.g. mem-09839b44" }),
      anchor: Type.Optional(Type.String({ description: "Evidence the re-check used: commit sha or file:line" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!store) throw new Error("memory store not initialized");
      if (writesDisabled) throw new Error("pi-memory writes disabled after storage error");
      const res = (await guard(() => handleMemoryVerify(store!, params), ctx)) as ReturnType<typeof handleMemoryVerify>;
      await updateWidget(ctx);
      return res;
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description:
      "Paged enumeration of stored memories (id, type, title, strength, status, anchor, verifiedAt) for auditing without reading files off disk",
    promptSnippet: "List/paginate stored memories (id, type, title, strength, status)",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["project", "global", "all"] as const)),
      type: Type.Optional(StringEnum(["decision", "fact", "lesson", "snapshot"] as const)),
      status: Type.Optional(StringEnum(["active", "superseded", "expired", "all"] as const)),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
      includeArchive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("memory store not initialized");
      return handleMemoryList(store, params);
    },
  });

  registerMemoryCommands(pi, {
    getStore: async () => withStore(),
    getConfig: () => cfg!,
  });
}
