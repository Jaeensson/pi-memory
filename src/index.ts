import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  handleMemoryRead,
  handleMemorySave,
  handleMemorySearch,
} from "./tools.js";
import { resolveProjectSlug } from "./store.js";

export default function (pi: ExtensionAPI) {
  const memoryRoot = join(homedir(), CONFIG_DIR_NAME, "agent", "memory");

  let cfg: MemoryConfig | undefined;
  let store: MarkdownStore | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let consolidating = false;
  let writesDisabled = false;

  const updateWidget = async (ctx: ExtensionContext) => {
    if (!store) return;
    const n = (await store.all()).length;
    ctx.ui.setWidget("pi-memory", [n > 0 ? `mem: ${n}` : undefined].filter((l): l is string => l !== undefined));
  };

  const resetIdleTimer = (ctx: ExtensionContext) => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!cfg?.enabled || !store || !ctx.model) return;
    idleTimer = setTimeout(() => {
      void runConsolidationSafely(ctx);
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

  const makeComplete = (ctx: ExtensionContext): CompleteFn => {
    return async (prompt: string) => {
      const registry = ctx.modelRegistry;
      let model = ctx.model;
      if (cfg?.consolidationModel) {
        const [providerId, ...rest] = cfg.consolidationModel.split("/");
        model = registry.find(providerId, rest.join("/")) ?? ctx.model;
      }
      if (!model || !registry.hasConfiguredAuth(model)) {
        throw new Error("no model configured for memory consolidation");
      }
      const response = await registry.complete(
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
        { cacheRetention: "none" },
      );
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    };
  };

  const runConsolidationSafely = async (ctx: ExtensionContext) => {
    if (!store || !cfg || consolidating || !ctx.model) return;
    let failed = false;
    consolidating = true;
    ctx.ui.setWidget("pi-memory", ["memory: consolidating…"]);
    try {
      const entries: SessionEntryLike[] = ctx.sessionManager.getBranch().map((e) => ({
        id: e.id,
        type: e.type,
        message: e.type === "message" ? (e.message as SessionEntryLike["message"]) : undefined,
      }));
      const result = await runConsolidation(store, entries, {
        complete: makeComplete(ctx),
        cfg,
        sessionId: ctx.sessionManager.getSessionId() ?? null,
        now: new Date(),
      });
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
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.setWidget("pi-memory", ["memory: idle (consolidation failed — will retry)"]);
      ctx.ui.notify(`pi-memory consolidation failed: ${msg}`, "warning");
    } finally {
      consolidating = false;
      if (!failed) await updateWidget(ctx);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    cfg = await loadConfig(memoryRoot);
    if (!cfg.enabled) return;
    const slug = await resolveProjectSlug(ctx.cwd);
    store = new MarkdownStore(memoryRoot, slug, cfg);
    await store.init();
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
    return { systemPrompt: `${event.systemPrompt}\n\n${block.text}` };
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetIdleTimer(ctx); // any new activity resets the idle timer (spec §7.1)
  });

  pi.on("agent_settled", async (_event, ctx) => {
    resetIdleTimer(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (idleTimer) clearTimeout(idleTimer);
    // Best-effort final consolidation with a short grace period.
    if (store && cfg?.enabled && ctx.model) {
      await Promise.race([
        runConsolidationSafely(ctx).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
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
    ],
    parameters: Type.Object({
      type: StringEnum(["decision", "fact", "lesson"] as const),
      title: Type.String({ description: "One-line specific summary" }),
      body: Type.String({ description: "2-6 sentences including the why" }),
      scope: Type.Optional(StringEnum(["project", "global"] as const)),
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
      type: Type.Optional(StringEnum(["decision", "fact", "lesson"] as const)),
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
    description: "Read full memory contents by id (1-5 ids); bumps usage",
    promptSnippet: "Read full memory entries by id",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
    }),
    async execute(_id, params) {
      if (!store) throw new Error("memory store not initialized");
      return handleMemoryRead(store, params);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Archive a wrong or obsolete memory by id",
    promptSnippet: "Archive a memory by id",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!store) throw new Error("memory store not initialized");
      if (writesDisabled) throw new Error("pi-memory writes disabled after storage error");
      const res = (await guard(() => handleMemoryForget(store!, params), ctx)) as ReturnType<typeof handleMemoryForget>;
      await updateWidget(ctx);
      return res;
    },
  });

  registerMemoryCommands(pi, {
    getStore: async () => withStore(),
    getConfig: () => cfg!,
  });
}
