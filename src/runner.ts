import { manifestOf } from "./actions.ts";
import { refreshChangePublication } from "./change-publication.ts";
import { getRepositoryPath } from "./config.ts";
import { branchConflictCode, CompetingImplementation, ImplementationEnded, SupersededError, WorkflowPushRejected } from "./errors.ts";
import { removeRunDatabase } from "./databases.ts";
import { GitHubRepository } from "./github.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { bestEffort, startOperation } from "./logging.ts";
import { observe } from "./observation.ts";
import { currentPrReview } from "./pr-assessment.ts";
import { reconcilePrReview } from "./pr-review-publication.ts";
import { getRun, latestCompletedRun } from "./run-history.ts";
import { publishRun } from "./publication.ts";
import { InterruptedError } from "./results.ts";
import { recordEvent } from "./events.ts";
import { assertCurrentImplementation, claimTask, deferImplementation, finishRun, interruptRun, retryTransientFailure } from "./tasks.ts";
import { isManual, parseTriggerInput, type TriggerInput } from "./triggers.ts";
import { getWorkspace, removeWorkspace, retainReplacedWorkspaces } from "./workspaces.ts";
import { changeRun, restartStaleDeferredPublication } from "./run-change.ts";
import { reviewRun } from "./run-review.ts";
import { type Ctx, type Observed, stopBefore } from "./run-context.ts";
import type { Run } from "./schema.ts";

async function connect({ subject, item, manifest }: Ctx): Promise<Observed | undefined> {
  if (!item) return;
  const { repository } = subject;
  const github = new GitHubRepository(repository);
  const context = await github.fetchItemContext(item.kind, item.payload.number);
  if (context.item.state !== "open") {
    if (item.kind === "issue" && manifest.publish.includes("pull_request")) throw new ImplementationEnded("GitHub issue closed");
    throw new Error("GitHub item is no longer open");
  }
  const pullRequest = "head" in context.item ? context.item : undefined;
  const observation = observe(context);
  const mainSha = await github.fetchBranch(observation.baseBranch);
  return { repository, github, context, pullRequest, item, observation, mainSha };
}

async function assertRepairCurrent(trigger: TriggerInput, { item, observation, mainSha }: Observed) {
  if (trigger.kind !== "low_grade") return;
  const state = await currentPrReview(item.id, observation, mainSha);
  if (state.kind !== "current" || state.assessment.originId !== trigger.assessmentRunId) {
    throw new Error("The review this repair addresses is no longer the current assessment");
  }
}

async function checkPublicationContext({ run, task, manifest }: Ctx, observed: Observed, evaluatedRun: Run, refetch: boolean) {
  const { github, context, item, observation, mainSha } = observed;
  const review = manifest.mode === "review";
  const publicationContext = refetch ? await github.fetchItemContext(observation.kind, item.payload.number) : context;
  const implementation = item.kind === "issue" && manifest.publish.includes("pull_request");
  if (publicationContext.item.state !== "open") {
    if (implementation) throw new ImplementationEnded("GitHub issue closed");
    throw new Error("GitHub item is no longer open");
  }
  let headOverride: string | undefined;
  if (!review && "head" in publicationContext.item && evaluatedRun.context?.headSha) {
    const { sha } = publicationContext.item.head;
    if (sha !== evaluatedRun.context.headSha && sha !== evaluatedRun.publication.publishedCommitSha
      && sha !== evaluatedRun.publication.commitSha) throw new Error("GitHub PR head changed during execution");
    headOverride = evaluatedRun.context.headSha;
  }
  const current = observe(publicationContext, headOverride);
  const currentMainSha = review ? async () => run.stage === "publishing" ? mainSha
    : await github.fetchBranch(current.baseBranch) : undefined;
  if (manifest.publish.includes("pr_assessment")) await currentMainSha?.();
  else if (!manifest.publish.includes("item_labels")) {
    const state = await freshness(savedEvaluation(evaluatedRun), { ...current, mainSha: currentMainSha }, "relevant-paths", true);
    if (state.kind === "stale") throw new Error(state.reason === "context"
      ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
      : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
  }
  if (implementation) {
    const workspace = evaluatedRun.workspaceId ? getWorkspace(evaluatedRun.workspaceId) : undefined;
    // After a push, the PR effect first reconciles our own PR before checking for competitors.
    const { publishedCommitSha, commentOnly } = evaluatedRun.publication;
    await assertCurrentImplementation(github, task, item.payload.number, current.baseBranch, workspace?.branch, !publishedCommitSha && !commentOnly);
  }
  return publicationContext;
}

async function publishStage(ctx: Ctx, observed: Observed | undefined) {
  const { task, run, subject, references, manifest } = ctx;
  const evaluated = getRun(run.id)!;
  if (!observed) return publishRun(new GitHubRepository(subject.repository), subject, task, evaluated, references);
  const { github } = observed;
  const current = await checkPublicationContext(ctx, observed, evaluated, run.stage !== "publishing");
  if (manifest.mode === "review") return publishRun(github, subject, task, evaluated, references, current);

  const publishRefreshed = async (candidate: Run) => {
    stopBefore(ctx.stop, "refreshed publication");
    const latest = await checkPublicationContext(ctx, observed, candidate, true);
    await publishRun(github, subject, task, candidate, references, latest);
  };
  const candidate = await refreshChangePublication(ctx, github, evaluated);
  if (candidate) return publishRefreshed(candidate);

  try { await publishRun(github, subject, task, evaluated, references, current); }
  catch (error) {
    if (!(error instanceof WorkflowPushRejected)) throw error;
    // Main can move between preflight and push. Retry only if a refresh can address it.
    await checkPublicationContext(ctx, observed, evaluated, true);
    const refreshed = await refreshChangePublication(ctx, github, getRun(run.id)!);
    if (!refreshed) throw error;
    await publishRefreshed(refreshed);
  }
}

const heapUsed = () => Math.round(process.memoryUsage().heapUsed / 1048576);

type ActiveRun = {
  subjectId: string;
  action: string;
  mode: ReturnType<typeof manifestOf>["mode"];
  manual: boolean;
  target?: string;
  supersede: (reason: string) => boolean;
};
const activeRuns = new Map<string, ActiveRun>();

export function supersedeRunningReviews(
  subjectId: string,
  reason: string,
  options?: { action?: string; keepManual?: boolean; unlessTarget?: string },
) {
  let count = 0;
  for (const active of activeRuns.values()) {
    if (active.subjectId !== subjectId || active.mode !== "review") continue;
    if (options?.action && active.action !== options.action) continue;
    if (options?.keepManual && active.manual) continue;
    if (options?.unlessTarget && (!active.target || active.target === options.unlessTarget)) continue;
    if (active.supersede(reason)) count++;
  }
  return count;
}

export async function runNextTask(stop?: AbortSignal) {
  const claimed = claimTask();
  if (!claimed) return;
  const { task, run, subject, item, resumingDeferred } = claimed;
  const manifest = manifestOf(task.action);
  const trigger = parseTriggerInput(task.input);
  const superseder = new AbortController();
  const runStop = stop ? AbortSignal.any([stop, superseder.signal]) : superseder.signal;
  const active: ActiveRun = {
    subjectId: subject.id,
    action: task.action,
    mode: manifest.mode,
    manual: isManual(trigger),
    supersede(reason) {
      if (superseder.signal.aborted || getRun(run.id)?.stage === "publishing") return false;
      superseder.abort(new SupersededError(reason));
      return true;
    },
  };
  activeRuns.set(run.id, active);
  const references = { subjectId: subject.id, taskId: task.id, runId: run.id };
  const operation = startOperation("run.execute", { ...references, action: task.action });
  const cleanup: Ctx["cleanup"] = { databaseRequested: false };
  const ctx: Ctx = { task, run, subject, item, references, operation, manifest, repositoryPath: getRepositoryPath(), stop: runStop, cleanup };
  try {
    const observed = await connect(ctx);
    if (observed?.pullRequest) active.target = `${observed.pullRequest.head.sha}@${observed.observation.baseBranch}`;
    if (observed && resumingDeferred) await restartStaleDeferredPublication(ctx, observed);
    if (observed && item?.kind === "issue" && ctx.manifest.publish.includes("pull_request") && run.stage !== "publishing") {
      const branch = item.workspaceId ? getWorkspace(item.workspaceId)?.branch : undefined;
      await assertCurrentImplementation(observed.github, task, item.payload.number, observed.observation.baseBranch, branch);
    }
    if (run.stage !== "publishing") {
      stopBefore(runStop, "workspace acquisition");
      if (trigger.kind === "pr_conflicts" && trigger.githubCi && !trigger.manual
        && (trigger.headSha !== observed?.pullRequest?.head.sha || trigger.mainSha !== observed?.mainSha)) {
        const skipped = finishRun(run.id, { status: "completed" });
        operation.complete({ skipped: "CI branch refresh was queued for an older PR revision" });
        return skipped;
      }
      if (observed && !run.retryOfRunId && !isManual(trigger) && run.stage === "preparing" && trigger.kind === "item_changed") {
        let staleReason: string | undefined;
        if (ctx.manifest.publish.includes("pr_assessment")) {
          const state = await currentPrReview(item!.id, observed.observation, observed.mainSha, run.id);
          if (state.kind === "current") {
            if (state.assessment.run.publication.status === "pending") {
              await bestEffort(operation.log, "pr.reconcile", references, () => reconcilePrReview(observed.github, item!.id, item!.payload.number, references));
            }
            staleReason = "No observed relevant changes since the authoritative review";
          } else if (state.kind === "blocked") {
            staleReason = "PR conflicts with its base branch; waiting for a new head";
          }
        } else if (item?.kind === "issue" && ctx.manifest.mode === "review" && !ctx.manifest.publish.includes("item_labels")) {
          const completed = latestCompletedRun(item.id, task.action);
          if (completed && (await freshness(savedEvaluation(completed), { ...observed.observation, mainSha: observed.mainSha }, "relevant-paths")).kind === "current") {
            staleReason = "No observed relevant changes since the last review";
          }
        }
        if (staleReason) {
          const skipped = finishRun(run.id, { status: "cancelled", error: new SupersededError(staleReason) });
          operation.complete({ cancelled: staleReason });
          return skipped;
        }
      }
      if (observed) await assertRepairCurrent(trigger, observed);
      if (ctx.manifest.mode === "review") await reviewRun(ctx, observed);
      else await changeRun(ctx, observed!, resumingDeferred);
      stopBefore(runStop, "publication");
    }
    await publishStage(ctx, observed);
    const finished = finishRun(run.id, { status: "completed" });
    if (finished.publication.status === "published" && finished.publication.publishedCommitSha) {
      await bestEffort(operation.log, "run.retention_pending", references, async () => retainReplacedWorkspaces(task.id));
    }
    operation.complete({ heapUsedMb: heapUsed() });
    return finished;
  } catch (error) {
    const cancelledError = error instanceof ImplementationEnded || error instanceof SupersededError ? error
      : superseder.signal.aborted && superseder.signal.reason instanceof SupersededError && getRun(run.id)?.stage !== "publishing"
        ? superseder.signal.reason : undefined;
    if (cancelledError) {
      const ended = finishRun(run.id, { status: "cancelled", error: cancelledError });
      operation.complete({ cancelled: cancelledError.message });
      return ended;
    }
    if (error instanceof CompetingImplementation) {
      const deferred = deferImplementation(run.id, error);
      operation.complete({ deferred: error.message, competingPullRequest: error.pullRequestNumber });
      return deferred;
    }
    if (error instanceof InterruptedError) {
      recordEvent({ ...references, type: "run.interrupting", data: { stage: getRun(run.id)!.stage, reason: error.message } });
      operation.complete({ interrupted: true, heapUsedMb: heapUsed() });
      interruptRun(run.id, error);
      return getRun(run.id)!;
    }
    if (retryTransientFailure(run.id, error)) {
      operation.fail(error, { heapUsedMb: heapUsed() });
      return getRun(run.id)!;
    }
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error, { heapUsedMb: heapUsed() });
    if (item?.kind === "pr" && ctx.manifest.publish.includes("pr_assessment") && failed.stage !== "publishing" && failed.error?.code !== branchConflictCode) {
      await bestEffort(operation.log, "github.review_reconciliation_pending", references,
        () => reconcilePrReview(new GitHubRepository(subject.repository), subject.id, item.payload.number, references));
    }
    return failed;
  } finally {
    activeRuns.delete(run.id);
    if (cleanup.databaseRequested) await bestEffort(operation.log, "run.cleanup_pending", { resource: "database" }, () => removeRunDatabase(run.id, references));
    if (cleanup.reviewWorkspace) await bestEffort(operation.log, "run.cleanup_pending", { workspaceId: cleanup.reviewWorkspace.id }, () => removeWorkspace(cleanup.reviewWorkspace!.id, references));
  }
}
