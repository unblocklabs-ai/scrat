import test from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const scenarios = {
  queue: "SQLite queue coalesces input, orders priorities, excludes busy workspaces and caps six tasks",
  routing: "GitHub routing reconciles all five actions and coalesces changing facts without invoking Pi",
  repository_sync: "repository sync bounds reads, shares scoped authentication, refreshes expired tokens and keeps raw diagnostics",
  sync_cost: "one fresh observation per PR, list-reused issue metadata, ETag 304s, rate-limit deferral and no duplicate review under routing/publication races",
  routing_history: "covered triggers and attempts skip unavailable review history without blocking later items",
  acceptance: "action postconditions reject empty implementations and unresolved conflicts but permit reply-only feedback",
  panel: "Scrat-authored PR gets two independent Pi sessions and one consolidated comment",
  canonical: "publication recovery and re-review preserve the recorded comment when feedback quotes its markers",
  deleted_review: "deleted canonical comments are restored from the authoritative saved assessment",
  unreceipted_review: "older retries preserve a newer remote review even when its write receipt was lost",
  stale_assessment: "a stale newest assessment clears its grade without resurrecting an older narrower review",
  assessment_order: "new inference on an old task outranks newer-created tasks regardless of timestamps",
  manual_queue: "manual tasks survive routing cancels and coalescing, run as normal authoritative reviews, die with their item, and enqueue by number",
  run_sequence: "claims assign increasing run sequences and the backfill preserves journal order, is idempotent and survives schema push",
  run_latest: "latest-run decisions follow claim sequence, not startedAt, for issue baselines and Pi session continuation",
  scope_snapshots: "PR-only, renamed and deleted paths keep their identities across unrelated base changes",
  grade_race: "sync invalidation and publication reconcile one current PR grade under concurrent execution",
  grade_failure: "grade delivery failures cannot prevent durable review tasks or block other PRs",
  absent_labels: "already absent labels reconcile without false removal events or hidden access failures",
  reviewer_failure: "a failed reviewer prevents consolidation and publication",
  footer: "quoted control markers stay report text and cannot supply a PR grade or issue approval",
  incomplete: "partial or undecided implementations never become PRs",
  verification: "verification receipts bind to the published commit and failing checks block publication",
  validation_mutation: "checks that change source cannot certify the resulting commit",
  validation_resume: "validation-only retry recreates PostgreSQL and validates saved code without Pi, then recovers publication",
  validation_guards: "validation checkpoints reject changed source, context and incomplete work while normal retry still repairs",
  resume_migration: "checkpoint schema updates preserve existing task and run history without inventing legacy checkpoints",
  retry: "publication retries reconcile remote comments and labels without rerunning Pi",
  ambiguous_pr: "a lost PR response is reconciled without another PR or inference",
  freshness: "requirements changed during inference cannot receive an approval label",
  freshness_policy: "one freshness policy distinguishes exact, context, irrelevant and relevant base changes",
  relevance: "root searches and unrelated development dependencies do not trigger re-review",
  lockfile_scope: "mixed lockfile changes cannot hide inspected packages, aliases or importer changes",
  importer_scope: "real importer bumps skip unrelated packages while aliases and unknown workspace shapes remain relevant",
  review_scope: "Pi path aliases and supplied PR diff files participate in freshness and re-review",
  unicode_scope: "Pi filename normalization cannot hide relevant base changes",
  unicode_nfd: "current and persisted Unicode read scopes map to Git filenames across filesystem spellings",
  legacy_scope: "historical unknown scope remains conservative even alongside known paths",
  merge: "retry resumes an unfinished merge and preserves partial work",
  reopen: "fetch-only reopening cannot keep a deleted workspace attached",
  existing_pr: "existing implementation PRs suppress duplicate implementation tasks",
  rejection: "invalid queued tasks are rejected with a journal reason while later work still runs, and bad static config blocks startup",
  recovery: "recover releases an abandoned claim without rewriting the saved result",
  cleanup: "cleanup failure cannot turn a published review into a failed task",
  single_repository: "sync, fetch, claims and clone refs refuse any repository other than the configured one",
  identity: "retained workspaces reject branch replacement and retain unpublished commits",
  feedback: "edited review summaries and same-commit PR retargets produce fresh tasks",
  git_paging: "git and read_base page bounded output from files and diffs larger than the 16 MiB buffer without loading them",
  commit_hook: "commit hooks cannot attach verification receipts to an unverified tree",
  isolation: "workspace commands, hooks and agent tools cannot reach Scrat credentials, and credential material is never published",
  wakeup: "idle workers wake on enqueue, keep signals sent while busy, fall back on timeout and release on abort",
  operations: "withOperation returns results, rethrows errors unchanged, logs the last stage on failure and works inside synchronous transactions",
  database: "real PostgreSQL runs isolate databases, apply new migrations and remove resources",
};

for (const [scenario, name] of Object.entries(scenarios)) {
  test(name, { timeout: 180_000 }, async (t) => {
    if (["database", "validation_resume"].includes(scenario)) {
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
