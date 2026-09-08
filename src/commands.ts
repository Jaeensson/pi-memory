import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "./config.js";
import { gatherInjection, renderMemoryBlock } from "./inject.js";
import type { MarkdownStore, MemoryFile } from "./store.js";

export function formatMemoryLabel(f: MemoryFile): string {
  return `[${f.id}] (${f.type} ×${f.useCount} s=${f.strength}) ${f.title}`;
}

export async function buildPreview(store: MarkdownStore, cfg: MemoryConfig): Promise<string> {
  const input = await gatherInjection(store, cfg);
  return renderMemoryBlock(input, cfg).text;
}

interface CommandDeps {
  getStore(): Promise<MarkdownStore | undefined>;
  getConfig(): MemoryConfig;
}

export function registerMemoryCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("memory", {
    description: "Browse, edit, pin, or forget saved memories",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const store = await deps.getStore();
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }
      const files = [...(await store.list("project")), ...(await store.list("global"))];
      if (files.length === 0) {
        ctx.ui.notify("No memories saved yet.", "info");
        return;
      }
      const byType = (t: string) => files.filter((f) => f.type === t).length;
      ctx.ui.notify(
        `${files.length} memories: ${byType("decision")} decisions, ${byType("fact")} facts, ${byType("lesson")} lessons`,
        "info",
      );
      const picked = await ctx.ui.select("Memory", files.map(formatMemoryLabel));
      if (picked === undefined) return;
      const file = files[files.map(formatMemoryLabel).indexOf(picked)]!;
      const action = await ctx.ui.select(`[${file.id}] ${file.title}`, [
        "View / edit body",
        file.pinned ? "Unpin" : "Pin (always inject)",
        "Forget (archive)",
      ]);
      if (action === undefined) return;
      if (action === "View / edit body") {
        const edited = await ctx.ui.editor(`Edit ${file.id}`, file.body);
        if (edited !== undefined && edited !== file.body) {
          file.body = edited;
          await store.update(file);
          ctx.ui.notify(`Updated ${file.id}`, "info");
        }
      } else if (action === "Pin (always inject)" || action === "Unpin") {
        file.pinned = !file.pinned;
        await store.update(file);
        ctx.ui.notify(`${file.pinned ? "Pinned" : "Unpinned"} ${file.id}`, "info");
      } else if (action === "Forget (archive)") {
        if (await ctx.ui.confirm("Forget memory?", `${file.title}\n\nIt will be archived, not deleted.`)) {
          await store.moveToArchive(file.id, "forgotten via /memory");
          ctx.ui.notify(`Archived ${file.id}`, "info");
        }
      }
    },
  });

  pi.registerCommand("memory-preview", {
    description: "Show exactly what pi-memory would inject right now",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const store = await deps.getStore();
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }
      const preview = await buildPreview(store, deps.getConfig());
      await ctx.ui.editor("Memory injection preview (read-only; cancel to discard)", preview);
    },
  });
}
