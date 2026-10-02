import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads the extension in the actual SDK and preserves prompt, routing, and storage contracts", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./fixtures/sdk-runtime.mjs", import.meta.url))], {
    env: { ...process.env, PI_OFFLINE: "1" }, timeout: 15000,
  });
  expect(stdout).toContain("SDK runtime probe passed");
}, 20000);
