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
  working_notes: "change sessions keep working notes in an excluded workspace file that never reaches a commit; reviews are not told to",
  implement_base_moved: "a retried implementation whose retained workspace began on an older base moves up to the current base first",
  run_sequence: "claims assign increasing run sequences and the backfill preserves journal order, is idempotent and survives schema push",
  run_latest: "latest-run decisions follow claim sequence, not startedAt, for issue baselines and Pi session continuation",
  scope_snapshots: "PR-only, renamed and deleted paths keep their identities across unrelated base changes",
  grade_race: "sync invalidation and publication reconcile one current PR grade under concurrent execution",
  grade_failure: "grade delivery failures cannot prevent durable review tasks or block other PRs",
  absent_labels: "already absent labels reconcile without false removal events or hidden access failures",
  publish_effects: "publication kinds apply an ordered list of effect primitives and skip each one whose receipt is already recorded",
  reviewer_failure: "a failed reviewer prevents consolidation and publication",
  footer: "quoted control markers stay report text and cannot supply a PR grade or issue approval",
  format_retry: "malformed final footers are corrected inside the same Pi session up to a cap, while incomplete and undecided outcomes are not",
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
  stale_branch: "a human PR whose branch is behind and cannot be prepared is reviewed on a local merge without pushing, or fails clearly when the merge conflicts",
  stale_branch_scrat: "behind Scrat PRs are merged in code, fall back to the agent when validation fails, self-heal feedback tasks and reach the agent when conflicting",
  validation_feedback: "a failed validation is sent back into the same Pi session, fixed there and published as one commit",
  validation_feedback_cap: "validation feedback stops after two rounds and never applies to signal-killed commands",
  command_timeout: "a validation command that outlives harness.commandTimeoutSeconds is killed, fails the run as infrastructure without re-prompting the agent and accepts validation-only retry",
  agent_timeout: "an agent turn that outlives harness.agentTimeoutSeconds is aborted and fails the run with AGENT_TIMEOUT",
  bash_guard: "heavy commands are refused in the agent's bash tool and bad guard or slot settings block startup",
  validation_slots: "validation waits for a configured number of slots, which a failing validation releases",
  merge: "retry resumes an unfinished merge and preserves partial work",
  reopen: "fetch-only reopening cannot keep a deleted workspace attached",
  existing_pr: "existing implementation PRs suppress duplicate implementation tasks",
  trigger_inputs: "every trigger input shape parses to one typed member, legacy rows classify by their fields, unknown shapes are rejected clearly and a malformed queued row is rejected at claim",
  rejection: "invalid queued tasks are rejected with a journal reason while later work still runs, and bad static config blocks startup",
  recovery: "recover releases an abandoned claim without rewriting the saved result",
  crash_before_publishing: "validated artifacts and the publishing stage are written together, so a run failed after validation resumes at publishing without validating again",
  cleanup: "cleanup failure cannot turn a published review into a failed task",
  sync_missing_item: "a deleted open item is marked closed and its failed read does not stop routing for the others",
  single_repository: "sync, fetch, claims and clone refs refuse any repository other than the configured one",
  identity: "retained workspaces reject branch replacement and retain unpublished commits",
  feedback: "edited review summaries and same-commit PR retargets produce fresh tasks",
  git_paging: "git and read_base page bounded output from files and diffs larger than the 16 MiB buffer without loading them",
  self_repair: "low grades on Scrat PRs queue one capped address_review repair per assessment that receives the report; good grades, human PRs and pending feedback do not",
  review_prior_assessment: "a re-review of a Scrat PR after a pushed repair gives both panel reviewers and the consolidator the previous assessment and repair summary; first reviews and human PRs get neither",
  commit_hook: "commit hooks cannot attach verification receipts to an unverified tree",
  isolation: "workspace commands, hooks and agent tools cannot reach Scrat credentials, and credential material is never published",
  wakeup: "idle workers wake on enqueue, keep signals sent while busy, fall back on timeout and release on abort",
  operations: "withOperation returns results, rethrows errors unchanged, logs the last stage on failure and works inside synchronous transactions",
  config_overrides: "scrat.local.json overrides merge over the defaults, are created when missing, reject unknown settings and reach Pi's providers",
  pat_auth: "a personal access token authenticates every GitHub call and git credential without the App, is redacted, and must belong to botLogin case-insensitively",
  bot_name: "a configured bot name replaces every prose mention of Scrat in model requests across all actions while protocol markers stay",
  bot_identity_names: "the selection label, its routing reason and the new branch prefix follow the bot name while the default scrat label stops selecting",
  slack_client: "the Slack client posts and replies in threads, retries one 429, surfaces outages and Slack errors, caps and escapes text",
  slack_startup: "an enabled Slack action blocks startup on missing token, channel, template variables, panel reviewers or a failed auth.test, while a disabled one makes no Slack call and queued tasks for it are rejected",
  slack_redaction: "the Slack token never reaches child environments, is caught as a secret, redacted from errors and absent from the journal",
  commits_source: "the base-branch commit source seeds silently, enqueues one range task per push, survives force-pushes and replays, and stops when disabled",
  commit_review_e2e: "a push to the base branch posts one templated root, runs one diff-only review and replies once in the thread without any GitHub write",
  commit_review_panel: "a panel commit review runs two reviewers and a consolidator without requiring a grade and replies once",
  commit_review_slack_down: "a failed root post still reviews and the reply creates the root, while a failed reply fails at publishing and retries without a new session or second root",
  commit_review_restart: "an interrupted commit review is recovered and retried with exactly one root and one reply",
  commit_review_isolation: "the commit review agent never sees the Slack token, reads base files and diffs against the previous SHA, and nothing is installed",
  subjects_migration: "the subjects migration moves items, tasks, events and Slack threads to subject ids, keeps every row, refuses unmapped tasks and is a no-op the second time",
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
