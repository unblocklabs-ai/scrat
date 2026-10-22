import test from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenario.mjs";

const execute = promisify(execFile);

for (const [scenario, { title, needsDocker }] of Object.entries(scenarios)) {
  test(title, { timeout: 180_000 }, async (t) => {
    if (needsDocker) {
      try { await execute("docker", ["info"], { timeout: 10_000 }); }
      catch { t.skip("Docker daemon is required for the PostgreSQL integration"); return; }
    }
    try {
      const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("scenario.mjs", import.meta.url)), scenario],
        { maxBuffer: 4 * 1024 * 1024, timeout: 170_000 });
      assert.match(stdout, /SCENARIO_PASSED/);
    } catch (error) {
      throw new Error(`${scenario}: ${error.message}\n${error.stderr ?? ""}\n${error.stdout ?? ""}`, { cause: error });
    }
  });
}
