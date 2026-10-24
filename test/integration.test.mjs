import test from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { scenarios } from "./scenario.mjs";

const execute = promisify(execFile);
let dockerProbe;
const dockerAvailable = () => dockerProbe ??= execute("docker", ["info"], { timeout: 10_000 }).then(() => true, () => false);

for (const [scenario, { title, needsDocker, needsSandbox, needsSystemd }] of Object.entries(scenarios)) {
  test(title, { timeout: 180_000 }, async (t) => {
    if (needsSandbox && (process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))) { t.skip("Linux bubblewrap is required for OS isolation"); return; }
    if (needsSystemd && (!process.env.XDG_RUNTIME_DIR || !existsSync("/usr/bin/systemd-run") || !existsSync(`${process.env.XDG_RUNTIME_DIR}/bus`))) { t.skip("A systemd user session is required for per-command memory limits"); return; }
    if (needsDocker && !(await dockerAvailable())) { t.skip("Docker daemon is required for the PostgreSQL integration"); return; }
    try {
      const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("scenario.mjs", import.meta.url)), scenario],
        { maxBuffer: 4 * 1024 * 1024, timeout: 170_000 });
      assert.match(stdout, /SCENARIO_PASSED/);
    } catch (error) {
      throw new Error(`${scenario}: ${error.message}\n${error.stderr ?? ""}\n${error.stdout ?? ""}`, { cause: error });
    }
  });
}
