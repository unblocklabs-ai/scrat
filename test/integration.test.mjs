import test from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const scenarios = {
  queue: "SQLite queue coalesces input, orders priorities, excludes busy workspaces and caps six tasks",
  panel: "Scrat-authored PR gets two independent Pi sessions and one consolidated comment",
  reviewer_failure: "a failed reviewer prevents consolidation and publication",
  incomplete: "partial or undecided implementations never become PRs",
  verification: "verification receipts bind to the published commit and failing checks block publication",
  validation_mutation: "checks that change source cannot certify the resulting commit",
  retry: "publication retries reconcile remote comments and labels without rerunning Pi",
  ambiguous_pr: "a lost PR response is reconciled without another PR or inference",
  freshness: "requirements changed during inference cannot receive an approval label",
  relevance: "default-path searches retain scope and unrelated base changes skip re-review",
  merge: "retry resumes an unfinished merge and preserves partial work",
  reopen: "fetch-only reopening cannot keep a deleted workspace attached",
  existing_pr: "existing implementation PRs suppress duplicate implementation tasks",
  recovery: "recover releases an abandoned claim without rewriting the saved result",
  cleanup: "cleanup failure cannot turn a published review into a failed task",
  identity: "retained workspaces reject branch replacement and retain unpublished commits",
  database: "real PostgreSQL runs isolate databases, apply new migrations and remove resources",
};

for (const [scenario, name] of Object.entries(scenarios)) {
  test(name, { timeout: 180_000 }, async (t) => {
    if (scenario === "database") {
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
