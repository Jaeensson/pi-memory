import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryConfig {
  enabled: boolean;
  idleSeconds: number;
  indexMaxLines: number;
  indexMaxBytes: number;
  pinnedMaxTokens: number;
  indexMaxTokens: number;
  pruneDays: number;
  pruneStrength: number;
  halfLifeDays: number;
  maxOpsPerRun: number;
  consolidationModel: string | null; // "provider/model-id" or null = current model
  globalEnabled: boolean;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  idleSeconds: 60,
  indexMaxLines: 60,
  indexMaxBytes: 4000,
  pinnedMaxTokens: 200,
  indexMaxTokens: 400,
  pruneDays: 30,
  pruneStrength: 0.3,
  halfLifeDays: 14,
  maxOpsPerRun: 12,
  consolidationModel: null,
  globalEnabled: true,
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

type ConfigValidator = (value: unknown) => boolean;
const isBoolean: ConfigValidator = (v) => typeof v === "boolean";
const isPositiveNumber: ConfigValidator = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegativeNumber: ConfigValidator = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isNonNegativeInteger: ConfigValidator = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPositiveInteger: ConfigValidator = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
const isUnitInterval: ConfigValidator = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isNullableString: ConfigValidator = (v) => v === null || typeof v === "string";

// Unvalidated values used to flow straight into timers and budgets, where a
// string like "soon" became NaN and fired setTimeout immediately. Every key is
// type/range-checked; an invalid value falls back to its default.
const CONFIG_VALIDATORS: Record<keyof MemoryConfig, ConfigValidator> = {
  enabled: isBoolean,
  idleSeconds: isPositiveNumber,
  indexMaxLines: isPositiveInteger,
  indexMaxBytes: isPositiveInteger,
  pinnedMaxTokens: isNonNegativeInteger,
  indexMaxTokens: isNonNegativeInteger,
  pruneDays: isNonNegativeNumber,
  pruneStrength: isUnitInterval,
  halfLifeDays: isPositiveNumber,
  maxOpsPerRun: isNonNegativeInteger,
  consolidationModel: isNullableString,
  globalEnabled: isBoolean,
};

export async function loadConfig(root: string): Promise<MemoryConfig> {
  const path = join(root, "config.json");
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    await mkdir(root, { recursive: true }); // root may not exist on first run (e.g. ~/.pi/agent/memory)
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: MemoryConfig = { ...DEFAULT_CONFIG };
    for (const key of CONFIG_KEYS) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (CONFIG_VALIDATORS[key as keyof MemoryConfig](value)) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG }; // corrupt config.json → defaults, never throw
  }
}
