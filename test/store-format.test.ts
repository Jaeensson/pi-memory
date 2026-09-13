import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  indexLine,
  parseMemoryFile,
  resolveProjectSlug,
  serializeMemoryFile,
  slugForPath,
  slugForRemote,
} from "../src/store.js";

const sample = (): Parameters<typeof serializeMemoryFile>[0] => ({
  id: "mem-a1b2c3d4",
  type: "decision",
  title: "Use pnpm workspace filters for test runs",
  created: "2026-09-08T09:00:00.000Z",
  lastUsed: "2026-09-08T09:00:00.000Z",
  useCount: 3,
  strength: 0.82,
  scope: "project",
  pinned: false,
  revision: 0,
  previousTitles: [],
  body: "Filter to the touched workspace to keep CI under 5 minutes.",
});

describe("parseMemoryFile / serializeMemoryFile", () => {
  it("round-trips a memory file", () => {
    const raw = serializeMemoryFile(sample());
    const parsed = parseMemoryFile(raw, "project");
    expect(parsed).toEqual(sample());
  });

  it("returns null on missing frontmatter", () => {
    expect(parseMemoryFile("just text, no frontmatter", "project")).toBeNull();
  });

  it("returns null on invalid frontmatter values", () => {
    const raw = [
      "---",
      "id: mem-a1b2c3d4",
      "type: bogus",
      "title: x",
      "created: nope",
      "lastUsed: nope",
      "useCount: -3",
      "strength: 5",
      "scope: project",
      "pinned: false",
      "revision: 0",
      "previousTitles: []",
      "---",
      "body",
    ].join("\n");
    expect(parseMemoryFile(raw, "project")).toBeNull();
  });

  it("applies fallbackScope when frontmatter scope is missing", () => {
    const raw = serializeMemoryFile(sample()).replace('scope: "project"\n', "");
    const parsed = parseMemoryFile(raw, "global");
    expect(parsed?.scope).toBe("global");
  });

  it("returns null when scope is present but invalid", () => {
    const raw = serializeMemoryFile(sample()).replace('scope: "project"', 'scope: "projecy"');
    expect(parseMemoryFile(raw, "project")).toBeNull();
  });

  it("returns null when a date is Date.parse-able but not ISO-8601 UTC", () => {
    const raw = serializeMemoryFile(sample()).replace(
      'created: "2026-09-08T09:00:00.000Z"',
      'created: "Sept 8, 2026"',
    );
    expect(parseMemoryFile(raw, "project")).toBeNull();
  });
});

describe("indexLine", () => {
  it("formats id, type, use count, title", () => {
    expect(indexLine(sample())).toBe(
      "- [mem-a1b2c3d4] (decision ×3) Use pnpm workspace filters for test runs",
    );
  });

  it("omits the use-count marker when useCount is 0", () => {
    const m = { ...sample(), useCount: 0 };
    expect(indexLine(m)).toBe(
      "- [mem-a1b2c3d4] (decision) Use pnpm workspace filters for test runs",
    );
  });
});

describe("slugForPath", () => {
  it("slugifies a posix path", () => {
    expect(slugForPath("/Users/rasmus/src/MyApp")).toBe("users-rasmus-src-myapp");
  });

  it("collapses separators and trims", () => {
    expect(slugForPath("/a//b/c/")).toBe("a-b-c");
  });
});

describe("slugForRemote", () => {
  it("slugifies an scp-style remote", () => {
    expect(slugForRemote("git@github.com:Jaeensson/pi-memory.git")).toBe(
      "github-com-jaeensson-pi-memory",
    );
  });

  it("maps an https remote to the same slug as the scp-style form", () => {
    expect(slugForRemote("https://github.com/Jaeensson/pi-memory.git")).toBe(
      "github-com-jaeensson-pi-memory",
    );
  });

  it("slugifies an ssh:// remote without a .git suffix", () => {
    expect(slugForRemote("ssh://git@gitlab.com/acme/widgets")).toBe(
      "gitlab-com-acme-widgets",
    );
  });

  it("falls back to the path slug for local-path remotes", () => {
    expect(slugForRemote("/srv/git/widgets.git")).toBe("srv-git-widgets");
  });
});

function makeGitRepo(originUrl?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pimem-slug-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (originUrl) {
    execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  }
  return dir;
}

describe("resolveProjectSlug", () => {
  it("uses the origin remote so the slug is identical on every machine", async () => {
    const repo = makeGitRepo("https://github.com/Jaeensson/pi-memory.git");
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(await resolveProjectSlug(sub)).toBe("github-com-jaeensson-pi-memory");
  });

  it("falls back to the repo root path slug when no remote exists", async () => {
    const repo = makeGitRepo();
    // git rev-parse --show-toplevel returns the canonical path; on macOS the temp
    // dir (/var/…) is a symlink to /private/var, so compare against the realpath.
    expect(await resolveProjectSlug(repo)).toBe(slugForPath(realpathSync(repo)));
  });

  it("falls back to the cwd path slug outside a git repo", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pimem-nogit-")), "deep", "nested");
    expect(await resolveProjectSlug(dir)).toBe(slugForPath(dir));
  });
});
