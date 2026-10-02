import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import memoryExtension from "../src/index.js";
import { MarkdownStore, slugForPath } from "../src/store.js";

export const TEST_MODEL: Model<"openai-completions"> = {
  id: "test-model", name: "Test model", provider: "test-provider", api: "openai-completions",
  baseUrl: "http://unused.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096,
};

export function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: "test-provider", model: "test-model", timestamp: Date.now(), stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider unavailable" } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

/** Real extension, files, and session tree; only UI and external model work are doubled. */
export async function createHarness(options: { customAgentDir?: boolean; prepare?: (home: string) => Promise<void> } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pimem-extension-")));
  const cwd = join(home, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  vi.stubEnv("HOME", home);
  const agentDir = options.customAgentDir ? join(home, "custom-agent") : join(home, ".pi", "agent");
  if (options.customAgentDir) vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  else vi.stubEnv("PI_CODING_AGENT_DIR", "");
  await options.prepare?.(home);

  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition<any>>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => { handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler)); };
    },
    registerTool(tool: ToolDefinition<any>) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  let completion = async (_signal?: AbortSignal) => response("[]");
  const sessionManager = SessionManager.inMemory(cwd);
  const notifications: { message: string; level?: string }[] = [];
  const ui = {
    setWidget: vi.fn(),
    notify(message: string, level?: string) { notifications.push({ message, level }); },
    select: vi.fn(async () => undefined as string | undefined),
    confirm: vi.fn(async () => false),
    editor: vi.fn(async () => undefined as string | undefined),
  };
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: TEST_MODEL, sessionManager,
    modelRegistry: {
      find: () => TEST_MODEL, hasConfiguredAuth: () => true,
      complete: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => completion(options?.signal),
      streamSimple: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => ({ result: () => completion(options?.signal) }),
    },
    isIdle: () => true, signal: undefined, ui,
  } as unknown as ExtensionContext;
  memoryExtension(api);
  const root = join(agentDir, "memory");
  const store = new MarkdownStore(root, slugForPath(cwd));
  return {
    home, cwd, agentDir, root, store, ctx, ui, sessionManager, notifications, tools, commands,
    setCompletion(fn: (signal?: AbortSignal) => Promise<AssistantMessage>) { completion = fn; },
    async emit(name: string, event: Record<string, unknown> = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
      return result;
    },
    async execute(name: string, params: unknown) {
      return tools.get(name)!.execute("test-call", params, undefined, undefined, ctx as any);
    },
  };
}
