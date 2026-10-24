import { manifestOf } from "./actions.ts";
import { getRepositoryPath } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { fetchRepository } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { startOperation } from "./logging.ts";
import { observe } from "./observation.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { currentPrReview } from "./pr-assessment.ts";
import { getRun } from "./run-history.ts";
import { publishRun, publishSubject } from "./publication.ts";
import { InterruptedError } from "./results.ts";
import { recordEvent } from "./events.ts";
import { claimTask, finishRun, interruptRun, retryTransientFailure } from "./tasks.ts";
import { parseTriggerInput } from "./triggers.ts";
import { removeWorkspace } from "./workspaces.ts";
import { changeRun } from "./run-change.ts";
import { reviewRun } from "./run-review.ts";
import { type Ctx, type Observed, stopBefore, tryCleanup } from "./run-context.ts";

async function connect({ subject, item, repositoryPath }: Ctx): Promise<Observed | undefined> {
  if (!item) return;
  const { repository } = subject;
  assertConfiguredRepository(repository);
  const github = new GitHubRepository(repository);
  const context = await github.fetchItemContext(item.kind, item.payload.number);
  if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
  const pullRequest = "head" in context.item ? context.item : undefined;
  const observation = observe(repository, context);
  const gitEnvironment = await github.getGitEnvironment();
  const mainSha = await fetchRepository(repositoryPath, observation.remote, observation.baseBranch, gitEnvironment);
  return { repository, github, context, pullRequest, item, observation, gitEnvironment, mainSha };
}

async function assertRepairCurrent({ task }: Ctx, { item, observation, mainSha }: Observed) {
  const trigger = parseTriggerInput(task.input);
  if (trigger.kind !== "low_grade") return;
  const state = await currentPrReview(item.id, observation, mainSha);
  if (state.kind !== "current" || state.assessment.originId !== trigger.assessmentRunId) {
    throw new Error("The review this repair addresses is no longer the current assessment");
  }
}

async function publishStage({ task, run, subject, references, manifest, repositoryPath }: Ctx, observed: Observed | undefined) {
  if (!observed) return publishSubject(subject, task, run, references);
  const { repository, github, context, item, observation, mainSha } = observed;
  const review = manifest.mode === "review";
  const evaluatedRun = getRun(run.id)!;
  const publicationContext = run.stage !== "publishing"
    ? await github.fetchItemContext(observation.kind, item.payload.number) : context;
  if (publicationContext.item.state !== "open") throw new Error("GitHub item is no longer open");
  let headOverride: string | undefined;
  if (!review && "head" in publicationContext.item && evaluatedRun.context?.headSha) {
    const { sha } = publicationContext.item.head;
    if (sha !== evaluatedRun.context.headSha && sha !== evaluatedRun.publication.publishedCommitSha
      && sha !== evaluatedRun.publication.commitSha) throw new Error("GitHub PR head changed during execution");
    headOverride = evaluatedRun.context.headSha;
  }
  const current = observe(repository, publicationContext, headOverride);
  const currentMainSha = review ? async () => run.stage === "publishing" ? mainSha
    : await fetchRepository(repositoryPath, observation.remote, current.baseBranch, await github.getGitEnvironment()) : undefined;
  if (manifest.publish.includes("pr_assessment")) await currentMainSha?.();
  else {
    const state = await freshness(savedEvaluation(evaluatedRun), { ...current, mainSha: currentMainSha }, "relevant-paths", true);
    if (state.kind === "stale") throw new Error(state.reason === "context"
      ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
      : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
  }
  await publishRun(github, task, evaluatedRun, publicationContext, references);
}

export async function runNextTask(stop?: AbortSignal) {
  const claimed = claimTask();
  if (!claimed) return;
  const { task, run, subject, item } = claimed;
  const references = { subjectId: subject.id, taskId: task.id, runId: run.id };
  const operation = startOperation("run.execute", { ...references, action: task.action });
  const cleanup: Ctx["cleanup"] = { databaseRequested: false };
  const ctx: Ctx = { task, run, subject, item, references, operation, manifest: manifestOf(task.action), repositoryPath: getRepositoryPath(), stop, cleanup };
  try {
    const observed = await connect(ctx);
    if (run.stage !== "publishing") {
      stopBefore(stop, "workspace acquisition");
      if (observed) await assertRepairCurrent(ctx, observed);
      if (ctx.manifest.mode === "review") await reviewRun(ctx, observed);
      else await changeRun(ctx, observed!);
      stopBefore(stop, "publication");
    }
    await publishStage(ctx, observed);
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return getRun(run.id)!;
  } catch (error) {
    if (error instanceof InterruptedError) {
      recordEvent({ ...references, type: "run.interrupting", data: { stage: getRun(run.id)!.stage, reason: error.message } });
      operation.complete({ interrupted: true });
      interruptRun(run.id, error);
      return getRun(run.id)!;
    }
    if (retryTransientFailure(run.id, error)) {
      operation.fail(error);
      return getRun(run.id)!;
    }
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (cleanup.databaseRequested) await tryCleanup(operation, { resource: "database" }, () => removeRunDatabase(run.id, references));
    if (cleanup.reviewWorkspace) await tryCleanup(operation, { workspaceId: cleanup.reviewWorkspace.id }, () => removeWorkspace(cleanup.reviewWorkspace!.id, references));
  }
}
