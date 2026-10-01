import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("extension package metadata", () => {
  it("declares host-provided runtime packages as wildcard peers", () => {
    for (const dependency of ["@earendil-works/pi-ai", "typebox"]) {
      expect(packageJson.peerDependencies?.[dependency]).toBe("*");
      expect(packageJson.dependencies ?? {}).not.toHaveProperty(dependency);
    }
  });
});
