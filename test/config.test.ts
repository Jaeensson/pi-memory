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

  it("falls back to defaults when config.json is not valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    await writeFile(join(root, "config.json"), "not json {", "utf8");
    await expect(loadConfig(root)).resolves.toEqual(DEFAULT_CONFIG);
  });

  it("rejects wrong-typed values and falls back to defaults per key", async () => {
    const root = await mkdtemp(join(tmpdir(), "pimem-"));
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        enabled: "no", // string, not boolean
        idleSeconds: "soon", // would become NaN → immediate timer
        indexMaxTokens: -5, // negative budget
        pruneStrength: 2, // outside [0, 1]
        maxOpsPerRun: 3.5, // non-integer
        consolidationModel: 42, // neither string nor null
        globalEnabled: false, // valid override
        halfLifeDays: 7, // valid override
      }),
      "utf8",
    );
    const cfg = await loadConfig(root);
    expect(cfg.enabled).toBe(true);
    expect(cfg.idleSeconds).toBe(DEFAULT_CONFIG.idleSeconds);
    expect(cfg.indexMaxTokens).toBe(DEFAULT_CONFIG.indexMaxTokens);
    expect(cfg.pruneStrength).toBe(DEFAULT_CONFIG.pruneStrength);
    expect(cfg.maxOpsPerRun).toBe(DEFAULT_CONFIG.maxOpsPerRun);
    expect(cfg.consolidationModel).toBeNull();
    expect(cfg.globalEnabled).toBe(false);
    expect(cfg.halfLifeDays).toBe(7);
  });

  it("creates a non-existent root directory on first run", async () => {
    const base = await mkdtemp(join(tmpdir(), "pimem-"));
    const root = join(base, "does-not-exist", "nested"); // no mkdir anywhere
    const cfg = await loadConfig(root);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    const written = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    expect(written.idleSeconds).toBe(60);
  });
});

import { readFile, writeFile } from "node:fs/promises";
