import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

// File format, slug logic, and the MarkdownStore persistence layer.

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
  const scope =
    fields.scope === undefined
      ? fallbackScope // field absent → caller's default
      : fields.scope === "project" || fields.scope === "global"
        ? fields.scope
        : null; // field present but invalid → corrupt
  if (scope === null) return null;
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  const isIsoUtc = (v: unknown): v is string =>
    typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
  const created = fields.created;
  const lastUsed = fields.lastUsed;
  if (!isIsoUtc(created) || !isIsoUtc(lastUsed)) return null;
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

// Callers (notably models) sometimes pass a memory id without the canonical
// "mem-" prefix, or in a different case. Normalize those to the canonical form
// so a valid id always resolves; return null for anything that is not an id, so
// an arbitrary string can never be turned into a filename.
const MEMORY_ID_RE = /^(?:mem-)?([0-9a-f]{8})$/i;
export function normalizeMemoryId(id: string): string | null {
  const match = MEMORY_ID_RE.exec(id.trim());
  return match ? `mem-${match[1].toLowerCase()}` : null;
}

export function slugForPath(p: string): string {
  return p
    .toLowerCase()
    .split("/")
    .filter((part) => part.length > 0)
    .join("-");
}

/**
 * Slug for a git remote URL. Machine-independent identity: the same repo
 * cloned at /home/... and /Users/... (or under different directory names)
 * yields the same slug, so a synced memory store serves one project dir.
 */
export function slugForRemote(url: string): string {
  const s = url.trim().toLowerCase().replace(/\.git$/, "");
  const urlForm = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:?]+)(?::\d+)?\/(.+)$/);
  const scpForm = s.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  const hostPath = urlForm ? `${urlForm[1]}/${urlForm[2]}` : scpForm ? `${scpForm[1]}/${scpForm[2]}` : null;
  if (!hostPath) return slugForPath(s); // local-path remotes: path-based slug
  return hostPath
    .split("/")
    .flatMap((part) => part.split(/[^a-z0-9]+/))
    .filter((part) => part.length > 0)
    .join("-");
}

export async function resolveProjectSlug(cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // Prefer the origin remote: stable across machines and checkout names.
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd });
    return slugForRemote(stdout.trim());
  } catch {
    // no origin remote (or not a git repo) — fall through
  }
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
    return slugForPath(stdout.trim());
  } catch {
    return slugForPath(cwd);
  }
}

export interface IndexLimits {
  indexMaxLines: number;
  indexMaxBytes: number;
}

const DEFAULT_LIMITS: IndexLimits = { indexMaxLines: 60, indexMaxBytes: 4000 };

function writeAtomic(path: string, data: string): Promise<void> {
  // Unique tmp suffix: two concurrent writes to the same path (parallel tool
  // calls are pi's default) must never share a tmp filename.
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  return writeFile(tmp, data, "utf8").then(() => rename(tmp, path));
}

export class MarkdownStore {
  readonly root: string;
  readonly projectSlug: string;
  private limits: IndexLimits;
  private corruptSkipped = 0;

  /** Serializes index writes so parallel mutations cannot race regenerateIndex. */
  private indexQueue: Promise<void> = Promise.resolve();

  /** Files skipped by listDir because their frontmatter failed to parse (spec §9 warn-once). */
  get corruptCount(): number {
    return this.corruptSkipped;
  }

  constructor(root: string, projectSlug: string, limits?: IndexLimits) {
    this.root = root;
    this.projectSlug = projectSlug;
    this.limits = limits ?? DEFAULT_LIMITS;
  }

  scopeDir(scope: MemoryScope): string {
    return scope === "global"
      ? join(this.root, "global")
      : join(this.root, "projects", this.projectSlug);
  }

  archiveDir(scope: MemoryScope): string {
    return join(this.scopeDir(scope), "archive");
  }

  async init(): Promise<void> {
    for (const scope of ["project", "global"] as const) {
      await mkdir(this.scopeDir(scope), { recursive: true });
      await mkdir(this.archiveDir(scope), { recursive: true });
    }
  }

  private fileTitle(id: string): string {
    return `${id}.md`;
  }

  async nextId(): Promise<string> {
    for (;;) {
      const id = `mem-${randomBytes(4).toString("hex")}`;
      if (await this.get(id)) continue;
      if (await this.findInDir(this.archiveDir("project"), id)) continue;
      if (await this.findInDir(this.archiveDir("global"), id)) continue;
      return id;
    }
  }

  private async findInDir(dir: string, id: string): Promise<boolean> {
    try {
      await readFile(join(dir, this.fileTitle(id)), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async save(input: {
    type: MemoryType;
    title: string;
    body: string;
    scope?: MemoryScope;
    pinned?: boolean;
  }): Promise<MemoryFile> {
    const scope = input.scope ?? "project";
    const now = new Date().toISOString();
    const file: MemoryFile = {
      id: await this.nextId(),
      type: input.type,
      title: input.title,
      created: now,
      lastUsed: now,
      useCount: 0,
      strength: 0.5,
      scope,
      pinned: input.pinned === true,
      revision: 0,
      previousTitles: [],
      body: input.body,
    };
    await writeAtomic(join(this.scopeDir(scope), this.fileTitle(file.id)), serializeMemoryFile(file));
    await this.regenerateIndex(scope);
    return file;
  }

  async get(id: string): Promise<MemoryFile | undefined> {
    const canonical = normalizeMemoryId(id);
    if (!canonical) return undefined;
    for (const scope of ["project", "global"] as const) {
      try {
        const raw = await readFile(join(this.scopeDir(scope), this.fileTitle(canonical)), "utf8");
        return parseMemoryFile(raw, scope) ?? undefined;
      } catch {
        // try next scope
      }
    }
    return undefined;
  }

  async update(file: MemoryFile): Promise<void> {
    await writeAtomic(join(this.scopeDir(file.scope), this.fileTitle(file.id)), serializeMemoryFile(file));
    await this.regenerateIndex(file.scope);
  }

  async list(scope: MemoryScope, opts?: { includeArchive?: boolean }): Promise<MemoryFile[]> {
    const active = await this.listDir(this.scopeDir(scope), scope);
    if (opts?.includeArchive) {
      active.push(...(await this.listDir(this.archiveDir(scope), scope)));
    }
    return active.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  }

  async all(): Promise<MemoryFile[]> {
    return [...(await this.list("project")), ...(await this.list("global"))];
  }

  private async listDir(dir: string, scope: MemoryScope): Promise<MemoryFile[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const files: MemoryFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      try {
        const raw = await readFile(join(dir, name), "utf8");
        const parsed = parseMemoryFile(raw, scope);
        if (parsed) files.push(parsed);
        else if (name !== "INDEX.md") this.corruptSkipped += 1; // generated index is not a memory file
      } catch {
        // unreadable file: skip
      }
    }
    return files;
  }

  async moveToArchive(id: string, reason?: string): Promise<boolean> {
    const canonical = normalizeMemoryId(id);
    if (!canonical) return false;
    for (const scope of ["project", "global"] as const) {
      const src = join(this.scopeDir(scope), this.fileTitle(canonical));
      let raw: string;
      try {
        raw = await readFile(src, "utf8");
      } catch {
        continue;
      }
      const dst = join(this.archiveDir(scope), this.fileTitle(canonical));
      await rename(src, dst);
      if (reason !== undefined) {
        const hash = createHash("sha256").update(reason + canonical).digest("hex").slice(0, 8);
        await writeFile(join(this.archiveDir(scope), `.reason-${hash}`), reason, "utf8");
      }
      await this.regenerateIndex(scope);
      return true;
    }
    return false;
  }

  async bumpUsage(ids: string[], now: Date = new Date()): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const file = await this.get(id);
      if (!file) continue;
      file.useCount += 1;
      file.lastUsed = now.toISOString();
      await this.update(file);
      count += 1;
    }
    return count;
  }

  async regenerateIndex(scope: MemoryScope): Promise<void> {
    // Exclusive: concurrent tool calls (pi's default) each end in a queued
    // regenerateIndex, so the final one always reflects every completed write.
    const run = this.indexQueue.then(() => this.regenerateIndexUnlocked(scope));
    this.indexQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async regenerateIndexUnlocked(scope: MemoryScope): Promise<void> {
    const files = (await this.listDir(this.scopeDir(scope), scope)).sort(
      (a, b) => b.strength - a.strength || a.id.localeCompare(b.id),
    );
    const lines: string[] = [];
    let bytes = 0;
    for (const f of files) {
      const line = indexLine(f);
      if (lines.length >= this.limits.indexMaxLines || bytes + line.length + 1 > this.limits.indexMaxBytes) break;
      lines.push(line);
      bytes += line.length + 1;
    }
    if (lines.length < files.length) {
      // The trailer occupies the last slot inside both caps; drop entry lines until it fits.
      // Hidden count = files.length - (rendered entry lines), honest with the trailer slot included.
      while (
        lines.length > 0 &&
        (lines.length + 1 > this.limits.indexMaxLines ||
          bytes + `…${files.length - lines.length} more — use memory_search`.length + 1 >
            this.limits.indexMaxBytes)
      ) {
        bytes -= lines.pop()!.length + 1;
      }
      lines.push(`…${files.length - lines.length} more — use memory_search`);
    }
    await writeAtomic(join(this.scopeDir(scope), "INDEX.md"), lines.join("\n") + (lines.length ? "\n" : ""));
  }

  async indexLines(scope: MemoryScope): Promise<string[]> {
    try {
      const raw = await readFile(join(this.scopeDir(scope), "INDEX.md"), "utf8");
      return raw.split("\n").filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }
}
