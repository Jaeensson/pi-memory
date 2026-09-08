import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults and creates config.json when missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    const cfg = await loadConfig(root);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    const written = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    expect(written.idleSeconds).toBe(60);
  });

  it("merges partial config over defaults and ignores unknown keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({ idleSeconds: 5, bogus: 1 }),
      "utf8",
    );
    const cfg = await loadConfig(root);
    expect(cfg.idleSeconds).toBe(5);
    expect(cfg.indexMaxTokens).toBe(DEFAULT_CONFIG.indexMaxTokens);
    expect((cfg as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

import { readFile, writeFile } from "node:fs/promises";
