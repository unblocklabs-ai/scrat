import { isDeepStrictEqual } from "node:util";
import { evaluateContext, readDiffScope } from "./agent-input.ts";
import { commitInput, describeCommit } from "./commit-review.ts";
import { describeWindow } from "./window-review.ts";
import { config, isBotLogin } from "./config.ts";
import { branchConflictCode } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { bestEffort } from "./logging.ts";
import { createMergeCommit, prepareTarget } from "./git.ts";
import { currentPrReview } from "./pr-assessment.ts";
import { getRun, latestCompletedRun, updateRun } from "./run-history.ts";
import { type AgentResult, assertComplete, hasReviewCheckpoint } from "./results.ts";
import type { Run, Workspace } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { isBaseOnly, parseTriggerInput } from "./triggers.ts";
import { createWorkspace, removeWorkspace } from "./workspaces.ts";
import { botAuthor, type Ctx, type Environment, itemRevisions, type Observed, prepareWorkspace, runAgent, stopBefore } from "./run-context.ts";

type Review = { workspace: Workspace; mainSha: string; headSha: string; diffBaseSha: string };

const reviewsStorefront = ({ subject, manifest, run }: Ctx) => config.storefront.enabled && subject.kind === "commit"
  && manifest.publish.includes("slack_reply") && commitInput(run.input).branch === config.github.baseBranch;

const auditsStorefront = ({ subject, manifest }: Ctx) => config.storefront.enabled && subject.kind === "window" && manifest.files.includes("storefront") && manifest.publish.includes("slack_reply");

async function settleReviewPlan(ctx: Ctx, { item, observation, mainSha }: Observed) {
  const { run, manifest } = ctx;
  if (run.reviewers.length !== 1) return false;
  const trigger = parseTriggerInput(run.input);
  if (isBaseOnly(trigger)) {
    const state = await currentPrReview(item.id, observation, mainSha);
    if (state.kind === "stale" && state.reason === "base" && (state.assessment.run.mainSha ?? null) === (trigger.previousMainSha ?? null)
      && (state.assessment.run.headSha ?? null) === (trigger.previousHeadSha ?? null)) return true;
  }
  const { reviewers, provider, model, thinkingLevel } = manifest;
  updateRun(run.id, { reviewers, provider, model, thinkingLevel });
  ctx.run = getRun(run.id)!;
  return false;
}

function reuseReviewers(ctx: Ctx, mainSha: string, headSha: string, revision: string) {
  const { run, references } = ctx, prior = run.retryOfRunId ? getRun(run.retryOfRunId) : undefined;
  const models = ({ reviewers }: Run) => reviewers.map(({ provider, model }) => `${provider}/${model}`);
  if (!prior || run.reviewers.length < 2 || prior.mainSha !== mainSha || prior.headSha !== headSha || prior.context?.revision !== revision
    || !isDeepStrictEqual(models(prior), models(run)) || prior.reviewers.some(({ result }) => result?.outcome !== "complete")) return;
  updateRun(run.id, { reviewers: prior.reviewers });
  ctx.run = getRun(run.id)!;
  recordEvent({ ...references, type: "run.reviewers_reused", data: { fromRunId: prior.id } });
}

async function retainedScope({ run, task }: Ctx, { item, observation, mainSha, pullRequest }: Observed, evaluated: ReturnType<typeof evaluateContext>, diffPaths: string[], paths: string[]) {
  const trigger = parseTriggerInput(run.input);
  if (trigger.kind !== "item_changed") return paths;
  const state = pullRequest ? await currentPrReview(item.id, observation, mainSha) : undefined;
  const previous = state ? "assessment" in state ? state.assessment.run : undefined : latestCompletedRun(item.id, task.action);
  if (!previous || previous.context?.revision !== evaluated.revision) return paths;
  const mainOnly = new Set(trigger.changedPaths);
  return [...new Set([...previous.result?.paths ?? [], ...diffPaths, ...paths.filter((path) => !mainOnly.has(path))])];
}

const itemScope = async ({ run, task, repositoryPath }: Ctx, observed: Observed) => {
  const { mainSha, headSha } = await itemRevisions(observed);
  return { mainSha, headSha, evaluated: evaluateContext(run, task, observed.observation), ...await readDiffScope(repositoryPath, mainSha, headSha, Boolean(observed.pullRequest)) };
};

async function prepareReviewCommands({ run, repositoryPath, references, operation, cleanup }: Ctx, { context, observation }: Observed, review: Review, environment: Environment) {
  try { await prepareWorkspace(review.workspace, environment, references); }
  catch (error) {
    if (isBotLogin(context.item.user?.login)) throw error;
    const { behind, conflicts } = await prepareTarget(review.workspace.path, review.mainSha, review.headSha);
    if (!behind) throw error;
    const { baseBranch } = observation;
    if (conflicts) throw Object.assign(new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`), { code: branchConflictCode });
    const synthetic = await createMergeCommit(repositoryPath, review.mainSha, review.headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
    cleanup.reviewWorkspace = undefined;
    await bestEffort(operation.log, "run.cleanup_pending", { workspaceId: review.workspace.id }, () => removeWorkspace(review.workspace.id, references));
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

type StorefrontChange = Parameters<typeof import("./storefront-main.ts").reviewStorefront>[1];

async function checkStorefront(ctx: Ctx, mainSha: string, result: AgentResult, change: () => Promise<StorefrontChange>) {
  const { id } = ctx.run;
  if (reviewsStorefront(ctx)) updateRun(id, { result: await (await import("./storefront-main.ts")).reviewStorefront(ctx, await change(), result) });
  else if (auditsStorefront(ctx)) updateRun(id, { result: await (await import("./storefront-main.ts")).auditStorefront(ctx, mainSha, result) });
  updateRun(id, { stage: "publishing" });
}

async function resumeReview(ctx: Ctx) {
  const { run, repositoryPath, references } = ctx;
  if (!hasReviewCheckpoint(run)) throw new Error("No complete review checkpoint to resume");
  const { result, mainSha, headSha } = run;
  await checkStorefront(ctx, mainSha, result, async () => {
    const { diffPaths, diffBaseSha, evaluated } = await describeCommit(ctx);
    const workspace = ctx.cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: headSha }, references);
    updateRun(run.id, { workspaceId: workspace.id });
    return { workspace, headSha, diffBaseSha, diffPaths, item: evaluated.item };
  });
}

export async function reviewRun(ctx: Ctx, observed: Observed | undefined) {
  const { run, subject, manifest, repositoryPath, stop } = ctx;
  if (run.stage === "validating") return resumeReview(ctx);
  const { mainSha, headSha, evaluated, diffPaths, diffBaseSha } = observed ? await itemScope(ctx, observed)
    : subject.kind === "window" ? await describeWindow(ctx) : await describeCommit(ctx);
  const workspace = ctx.cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: headSha }, ctx.references);
  updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha, context: evaluated });
  const review: Review = { workspace, mainSha, headSha, diffBaseSha };
  const environment: Environment = observed ? { ...config.workspace.environment } : {};
  stopBefore(stop, "workspace preparation");
  if (observed?.pullRequest) await prepareReviewCommands(ctx, observed, review, { ...childEnvironment(), ...environment });
  else if (observed) ctx.operation.log.info({ event: "workspace.prepare_skipped", reason: "issue review" });
  if (observed) await refreshPreview(ctx, observed, review);
  stopBefore(stop, "the agent");
  const changeContext = manifest.context === "change";
  const baseOnly = observed ? await settleReviewPlan(ctx, observed) : false;
  if (manifest.agent === "panel") reuseReviewers(ctx, mainSha, headSha, evaluated.revision);
  updateRun(run.id, { stage: "agent" });
  const { result } = await runAgent(ctx, {
    environment, baseSha: changeContext ? review.diffBaseSha : undefined,
    panel: manifest.agent === "panel" ? { baseSha: review.diffBaseSha, requireGrade: !changeContext } : undefined,
    input: { workspace: review.workspace, evaluated, diffBaseSha: review.diffBaseSha, diffPaths, mainSha: review.mainSha, headSha: review.headSha, baseRef: review.mainSha, mergeInProgress: false, baseOnly },
  });
  if (observed) result.paths = await retainedScope(ctx, observed, evaluated, diffPaths, result.paths);
  updateRun(run.id, { result, stage: "validating" });
  assertComplete(result);
  await checkStorefront(ctx, mainSha, result, async () => ({ ...review, diffPaths, item: evaluated.item }));
}
