import { getActionConfig } from "./actions.ts";
import { evaluateContext, readDiffScope } from "./agent-input.ts";
import { commitInput, describeCommit, startCommitThread } from "./commit-review.ts";
import { describeWindow } from "./window-review.ts";
import { config, isBotLogin } from "./config.ts";
import { branchConflictCode } from "./errors.ts";
import { createMergeCommit, fetchRepository, prepareTarget } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { assertConfiguredRepository, remoteUrl } from "./repository.ts";
import { currentPrReview } from "./pr-assessment.ts";
import { getRun, updateRun } from "./run-history.ts";
import { assertComplete } from "./results.ts";
import type { Workspace } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { configuredReviewers } from "./tasks.ts";
import { isBaseOnly, parseTriggerInput } from "./triggers.ts";
import { createWorkspace, removeWorkspace } from "./workspaces.ts";
import { botAuthor, type Ctx, type Environment, itemRevisions, type Observed, prepareWorkspace, runAgent, stopBefore, tryCleanup } from "./run-context.ts";

type Review = { workspace: Workspace; mainSha: string; headSha: string; diffBaseSha: string };

async function settleReviewPlan(ctx: Ctx, { item, observation, mainSha }: Observed) {
  const { run, task } = ctx;
  if (run.reviewers.length !== 1) return;
  const trigger = parseTriggerInput(run.input);
  if (isBaseOnly(trigger)) {
    const state = await currentPrReview(item.id, observation, mainSha);
    if (state.kind === "stale" && state.reason === "base" && (state.assessment.run.mainSha ?? null) === (trigger.previousMainSha ?? null)
      && (state.assessment.run.headSha ?? null) === (trigger.previousHeadSha ?? null)) return;
  }
  const { provider, model, thinkingLevel } = getActionConfig(task.action);
  updateRun(run.id, { reviewers: configuredReviewers(task.action), provider, model, thinkingLevel });
  ctx.run = getRun(run.id)!;
}

async function commitRevisions({ subject, run, task, manifest, operation }: Ctx) {
  const input = commitInput(run.input), { sha } = input;
  if (manifest.start?.includes("slack_post")) await startCommitThread(subject, task.action, input, operation.log);
  return { mainSha: sha, headSha: sha };
}

async function windowRevisions({ subject, repositoryPath }: Ctx) {
  const { repository } = subject;
  assertConfiguredRepository(repository);
  const mainSha = await fetchRepository(repositoryPath, remoteUrl(repository), config.github.baseBranch, await new GitHubRepository(repository).getGitEnvironment());
  return { mainSha, headSha: mainSha };
}

async function prepareReviewCommands({ run, repositoryPath, references, operation, cleanup }: Ctx, { context, pullRequest, observation }: Observed, review: Review, environment: Environment) {
  try { await prepareWorkspace(review.workspace, environment, references); }
  catch (error) {
    if (!pullRequest || isBotLogin(context.item.user?.login)) throw error;
    const { behind, conflicts } = await prepareTarget(review.workspace.path, review.mainSha, review.headSha);
    if (!behind) throw error;
    const { baseBranch } = observation;
    if (conflicts) throw Object.assign(new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`), { code: branchConflictCode });
    const synthetic = await createMergeCommit(repositoryPath, review.mainSha, review.headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
    cleanup.reviewWorkspace = undefined;
    await tryCleanup(operation, { workspaceId: review.workspace.id }, () => removeWorkspace(review.workspace.id, references));
    review.workspace = cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: synthetic }, references);
    updateRun(run.id, { workspaceId: review.workspace.id });
    review.headSha = synthetic;
    review.diffBaseSha = review.mainSha;
    await prepareWorkspace(review.workspace, environment, references);
  }
}

async function refreshPreview({ manifest, operation, stop, references, repositoryPath }: Ctx, { pullRequest, github, context }: Observed, review: Review) {
  if (!config.storefront.enabled || !manifest.publish.includes("pr_assessment") || !pullRequest || !isBotLogin(pullRequest.user?.login)) return;
  const { ensurePreview } = await import("./storefront.ts");
  const { number } = pullRequest;
  try { await ensurePreview({ github, number, comments: context.comments, references }, { repositoryPath, baseSha: review.diffBaseSha, headSha: review.headSha }, stop); }
  catch (error) { if (!stop?.aborted) operation.log.warn({ event: "storefront.preview_failed", subjectId: references.subjectId, number, err: error }); }
}

export async function reviewRun(ctx: Ctx, observed: Observed | undefined) {
  const { task, run, subject, manifest, repositoryPath, stop } = ctx;
  const { mainSha, headSha } = observed ? await itemRevisions(ctx, observed)
    : subject.kind === "window" ? await windowRevisions(ctx) : await commitRevisions(ctx);
  const workspace = ctx.cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: headSha }, ctx.references);
  updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha });
  const { evaluated, diffPaths, diffBaseSha } = observed
    ? { evaluated: evaluateContext(run, task, observed.observation), ...await readDiffScope(workspace.path, mainSha, headSha, Boolean(observed.pullRequest)) }
    : subject.kind === "window" ? describeWindow(task.action, subject, mainSha) : await describeCommit(repositoryPath, subject, run.input);
  updateRun(run.id, { context: evaluated });
  const review: Review = { workspace, mainSha, headSha, diffBaseSha };
  const environment: Environment = observed ? { ...config.workspace.environment } : {};
  stopBefore(stop, "workspace preparation");
  if (observed) await prepareReviewCommands(ctx, observed, review, { ...childEnvironment(), ...environment });
  if (observed) await refreshPreview(ctx, observed, review);
  stopBefore(stop, "the agent");
  const changeContext = manifest.context === "change";
  if (observed) await settleReviewPlan(ctx, observed);
  updateRun(run.id, { stage: "agent" });
  const { result } = await runAgent(ctx, {
    environment, baseSha: changeContext ? review.diffBaseSha : undefined,
    panel: manifest.agent === "panel" ? { baseSha: review.diffBaseSha, requireGrade: !changeContext } : undefined,
    input: { workspace: review.workspace, evaluated, diffBaseSha: review.diffBaseSha, diffPaths, mainSha: review.mainSha, headSha: review.headSha, baseRef: review.mainSha, mergeInProgress: false },
  });
  updateRun(run.id, { result, stage: "validating" });
  assertComplete(result);
  updateRun(run.id, { stage: "publishing" });
}
