// File format + slug logic. The MarkdownStore class is added in the next task.

export type MemoryType = "decision" | "fact" | "lesson";
export type MemoryScope = "project" | "global";

export interface MemoryMeta {
  id: string;
  type: MemoryType;
  title: string;
  created: string;
  lastUsed: string;
  useCount: number;
  strength: number;
  scope: MemoryScope;
  pinned: boolean;
  revision: number;
  previousTitles: string[];
}

export interface MemoryFile extends MemoryMeta {
  body: string;
}

const META_ORDER: (keyof MemoryMeta)[] = [
  "id",
  "type",
  "title",
  "created",
  "lastUsed",
  "useCount",
  "strength",
  "scope",
  "pinned",
  "revision",
  "previousTitles",
];

export function serializeMemoryFile(m: MemoryFile): string {
  const lines = META_ORDER.map((key) => {
    const value = m[key];
    return `${key}: ${JSON.stringify(value)}`;
  });
  return `---\n${lines.join("\n")}\n---\n${m.body.replace(/\n?$/, "\n")}`;
}

export function parseMemoryFile(raw: string, fallbackScope: MemoryScope): MemoryFile | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const [, fm, body] = match;
  const fields: Record<string, unknown> = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value: unknown = line.slice(idx + 1).trim();
    try {
      value = JSON.parse(value as string);
    } catch {
      return null; // all our values are JSON scalars/arrays
    }
    fields[key] = value;
  }
  const id = fields.id;
  if (typeof id !== "string" || !/^mem-[0-9a-f]{8}$/.test(id)) return null;
  const type = fields.type;
  if (type !== "decision" && type !== "fact" && type !== "lesson") return null;
  const scope = fields.scope === "global" ? "global" : fields.scope === "project" ? "project" : fallbackScope;
  const created = fields.created;
  const lastUsed = fields.lastUsed;
  if (typeof created !== "string" || Number.isNaN(Date.parse(created))) return null;
  if (typeof lastUsed !== "string" || Number.isNaN(Date.parse(lastUsed))) return null;
  const useCount = fields.useCount;
  if (typeof useCount !== "number" || !Number.isInteger(useCount) || useCount < 0) return null;
  const strength = fields.strength;
  if (typeof strength !== "number" || strength < 0 || strength > 1) return null;
  if (typeof fields.title !== "string") return null;
  const previousTitles = fields.previousTitles;
  if (!Array.isArray(previousTitles) || previousTitles.some((t) => typeof t !== "string")) return null;
  return {
    id,
    type,
    title: fields.title,
    created,
    lastUsed,
    useCount,
    strength,
    scope,
    pinned: fields.pinned === true,
    revision: typeof fields.revision === "number" ? fields.revision : 0,
    previousTitles: previousTitles as string[],
    body: body.replace(/\n$/, ""), // drop the single newline serializeMemoryFile appends
  };
}

export function indexLine(m: MemoryFile): string {
  const uses = m.useCount > 0 ? ` ×${m.useCount}` : "";
  return `- [${m.id}] (${m.type}${uses}) ${m.title}`;
}

export function slugForPath(p: string): string {
  return p
    .toLowerCase()
    .split("/")
    .filter((part) => part.length > 0)
    .join("-");
}

export async function resolveProjectSlug(cwd: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd });
    return slugForPath(stdout.trim());
  } catch {
    return slugForPath(cwd);
  }
}
