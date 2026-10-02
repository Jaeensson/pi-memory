import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = process.env.PI_MEMORY_TEST_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const sdkModule = (path) => import(pathToFileURL(join(sdkRoot, path)).href);
const { ModelRuntime, ModelRegistry, ExtensionRunner, SessionManager, createEventBus } = await sdkModule("dist/index.js");
const { loadExtensions, loadExtensionFromFactory } = await sdkModule("dist/core/extensions/loader.js");
const { buildSystemPrompt, buildSystemPromptSections } = await sdkModule("dist/core/system-prompt.js");
const home = await mkdtemp(join(tmpdir(), "pimem-runtime-"));
process.env.HOME = home;
delete process.env.PI_CODING_AGENT_DIR;
process.env.PI_OFFLINE = "1";

try {
  const cwd = join(home, "workspace");
  const root = join(home, ".pi", "agent", "memory");
  await mkdir(cwd);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(join(home, "shared-memory"));
  await symlink(join(home, "shared-memory"), root, "dir");
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  let routes = 0;
  modelRuntime.registerVirtualModel({ provider: "audit-router", id: "auto", name: "Audit router", route() {
    routes++;
    throw new Error("intentional offline route failure");
  } });
  const registry = new ModelRegistry(modelRuntime);
  const model = registry.find("audit-router", "auto");
  assert(model);
  const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([entry], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const sessions = SessionManager.inMemory(cwd);
  sessions.appendMessage({ role: "user", content: "Use an embedded cache.", timestamp: Date.now() });
  const warnings = [];
  const ctx = { cwd, model, modelRegistry: registry, sessionManager: sessions, hasUI: false, mode: "print",
    isIdle: () => true, ui: { setWidget() {}, notify(text, level) { if (level === "warning") warnings.push(text); } } };
  const emit = async (name) => { for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, ctx); };
  await emit("session_start");
  const save = extension.tools.get("memory_save").definition;
  await save.execute("seed", { type: "fact", title: "Runtime fact", body: "RUNTIME_MEMORY_RULE", pinned: true }, undefined, undefined, ctx);

  const later = await loadExtensionFromFactory((pi) => pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.late_runtime = "LATE_RUNTIME_RULE";
  }), cwd, createEventBus(), loaded.runtime);
  const runner = new ExtensionRunner([extension, later], loaded.runtime, cwd, sessions, registry);
  const result = await runner.emitBeforeAgentStart("hello", undefined, { cwd, customPrompt: "BASE", sections: {} });
  assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
  assert(buildSystemPrompt(result.systemPromptOptions).includes("RUNTIME_MEMORY_RULE"));
  assert(buildSystemPrompt(result.systemPromptOptions).includes("LATE_RUNTIME_RULE"));
  assert(JSON.stringify(buildSystemPromptSections(result.systemPromptOptions)).includes("RUNTIME_MEMORY_RULE"));

  await emit("session_shutdown");
  assert.equal(routes, 1, "consolidation must dispatch virtual selections through their router");
  assert(warnings.some((text) => text.includes("intentional offline route failure")));
  const projectDirs = await (await import("node:fs/promises")).readdir(join(root, "projects"));
  const watermarkPath = join(root, "projects", projectDirs[0], "state.json");
  await assert.rejects(readFile(watermarkPath), { code: "ENOENT" });
  assert((await lstat(root)).isSymbolicLink());
  console.log("SDK runtime probe passed: loader, prompt composition/persistence, virtual routing, watermark safety, symlink preservation");
} finally {
  await rm(home, { recursive: true, force: true });
}
