import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { config, getRepositoryPath, isBotLogin } from "./config.ts";
import { botSlug } from "./identity.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { acknowledgedTaskIds, commentKey } from "./markers.ts";
import type { Item } from "./items.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { remoteUrl } from "./repository.ts";
import { labelName, reconcileLabels } from "./labels.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts, isAncestor } from "./git.ts";
import { rateLimitLow, rateLimitState, type GitHubRepository } from "./github.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import { items, runs, subjects } from "./schema.ts";
import { cancelQueuedTasks, enqueueTask, latestTask } from "./tasks.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";
import { reconcileObserved, serializePr } from "./pr-review-publication.ts";
import { completedRunsOfAction, latestFinishedRun, latestRunOfTask, runHistory } from "./run-history.ts";
import { resolvePrReview, type PrReviewState } from "./pr-assessment.ts";
import { planIssueTasks, planPrMaintenance, planReview, planSelfRepair, lowGrades, reviewTrigger, type RoutingDecision } from "./github-routing.ts";

type SyncContext = {
  github: GitHubRepository; repository: string; repositoryPath: string; remote: string;
  env: Awaited<ReturnType<GitHubRepository["getGitEnvironment"]>>; log: Logger;
};
type PrMaintenanceFacts = Parameters<typeof planPrMaintenance>[0];

function hasScratLabel(item: Item) {
  return item.payload.labels?.some((label) => labelName(label) === botSlug);
}

function applyDecisions(subjectId: string, decisions: RoutingDecision[]) {
  let queued = 0;
  for (const decision of decisions) {
    if (decision.type === "cancel") cancelQueuedTasks(subjectId, decision.reason, decision.action, true);
    else { enqueueTask({ subjectId, action: decision.action, reason: decision.reason, input: decision.input }); queued++; }
  }
  return queued;
}

let syncRound = 0;
const limitLogged = new Set<string>();

async function cleanupClosedItem(item: Item) {
  cancelQueuedTasks(item.id, "GitHub item closed");
  if (item.kind !== "pr" || !item.workspaceId) return;
  const active = db.select().from(runs).where(and(eq(runs.workspaceId, item.workspaceId), isNull(runs.finishedAt))).get();
  const workspace = getWorkspace(item.workspaceId);
  if (active || !workspace || workspace.removedAt) return;
  const related = db.select().from(subjects).where(eq(subjects.workspaceId, workspace.id)).all();
  for (const linked of related) cancelQueuedTasks(linked.id, "PR merged or closed");
  try { await removeWorkspace(workspace.id, { subjectId: item.id }); }
  catch { }
}

async function gatherPrMaintenanceFacts(ctx: SyncContext, item: Item, observation: ItemObservation, pr: GithubPullRequest, mainSha: string): Promise<PrMaintenanceFacts> {
  const { repositoryPath, remote, env } = ctx;
  const headRef = await fetchPullRequestHead(repositoryPath, remote, pr.number, env);
  const headSha = await git(repositoryPath, ["rev-parse", headRef]);
  const conflicts = await hasConflicts(repositoryPath, mainSha, headSha);
  const lastRun = latestFinishedRun(item.id);
  const stale = !conflicts && Boolean(lastRun?.error) && lastRun?.stage === "preparing" && lastRun.headSha === headSha
    && !await isAncestor(repositoryPath, mainSha, headSha);
  const acknowledged = new Set(observation.own.flatMap((comment) => acknowledgedTaskIds(comment.body)));
  const handled = runHistory(item.id, "address_pr_feedback")
    .filter(({ run, task }) => (!run.finishedAt && task.status === "running") || (run.finishedAt && !run.error)
      || run.publication.commentId || acknowledged.has(task.id));
  const consumed = new Set(handled.flatMap(({ run }) => {
    if (run.context) return run.context.commentRevisions;
    const legacy = run.input.commentRevisions;
    return Array.isArray(legacy) ? legacy.filter((entry: unknown): entry is string => typeof entry === "string") : [];
  }));
  const pending = observation.external.filter((comment) => !consumed.has(commentKey(comment)));
  return {
    conflicts, stale, mainSha, headSha, pendingComments: pending.map((comment) => commentKey(comment)),
    conflictTask: latestTask(item.id, "resolve_conflicts"), feedbackTask: latestTask(item.id, "address_pr_feedback"),
  };
}

async function reconcileExhaustedLabel(ctx: SyncContext, item: Item, observation: ItemObservation, owned: boolean, state: PrReviewState, count: number) {
  const { exhaustedLabel, maxSelfRepairs } = config.actions.address_review;
  const latestRepair = latestTask(item.id, "address_review");
  const repairActive = latestRepair?.status === "queued" || latestRepair?.status === "running";
  if (!exhaustedLabel || !owned || state.kind !== "current" || repairActive) return;
  const exhausted = lowGrades.includes(state.assessment.result.grade) && count >= maxSelfRepairs;
  try {
    await reconcileLabels(ctx.github, item.payload.number, { current: observation.labels, desired: exhausted ? [exhaustedLabel] : [], managed: [exhaustedLabel] }, { subjectId: item.id });
  } catch (error) { ctx.log.warn({ event: "self_repair.label_pending", subjectId: item.id, err: error }); }
}

async function routePrReview(ctx: SyncContext, item: Item, observation: ItemObservation, mainSha: string, owned: boolean) {
  const latest = latestTask(item.id, "review_pr");
  const reviews = runHistory(item.id, "review_pr");
  const attempt = reviews.find(({ task }) => task.id === latest?.id)?.run;
  const state = await resolvePrReview(reviews, observation, mainSha);
  let added = applyDecisions(item.id, planReview({ kind: "pr", state, latest, attempt, revision: observation.revision, mainSha }));
  const { maxSelfRepairs } = config.actions.address_review;
  const count = db.select({ count: items.selfRepairCount }).from(items).where(eq(items.id, item.id)).get()!.count;
  const repair = planSelfRepair({
    owned, state, feedbackTask: latestTask(item.id, "address_pr_feedback"),
    reviewTask: latestTask(item.id, "review_pr"), repairTask: latestTask(item.id, "address_review"), count, limit: maxSelfRepairs,
  });
  if (repair.limited && state.kind === "current" && !limitLogged.has(state.assessment.originId)) {
    limitLogged.add(state.assessment.originId);
    ctx.log.info({ event: "self_repair.limit_reached", subjectId: item.id, limit: maxSelfRepairs }, "Self-repair limit reached");
  }
  added += applyDecisions(item.id, repair.decisions);
  await reconcileExhaustedLabel(ctx, item, observation, owned, state, count);
  return added;
}

async function routeIssueReview(item: Item, observation: ItemObservation, mainSha: string) {
  const latest = latestTask(item.id, "review_issue");
  const attempt = latest ? latestRunOfTask(latest.id) : undefined;
  const { revision } = observation;
  if (reviewTrigger({ latest, attempt, revision, mainSha }).covered) return 0;
  const completed = completedRunsOfAction(item.id, "review_issue", 1)[0];
  const state = completed ? await freshness(savedEvaluation(completed), { ...observation, mainSha }, "relevant-paths") : undefined;
  return applyDecisions(item.id, planReview({ kind: "issue", completed, freshness: state, latest, attempt, revision, mainSha }));
}

async function routeObserved(ctx: SyncContext, item: Item, context: GithubContext, defaultBaseSha: string) {
  if (context.item.state !== "open") return 0;
  const { github, repository, repositoryPath, remote, env, log } = ctx;
  const observation = observe(repository, context);
  const mainSha = observation.kind === "pr" && observation.baseBranch !== config.github.baseBranch
    ? await fetchRepository(repositoryPath, remote, observation.baseBranch, env) : defaultBaseSha;
  const owned = item.kind === "pr" && isBotLogin(context.item.user?.login);
  let added = 0;
  if (owned && "head" in context.item) {
    if (context.item.head.repo?.full_name !== repository) return added;
    added += applyDecisions(item.id, planPrMaintenance(await gatherPrMaintenanceFacts(ctx, item, observation, context.item, mainSha)));
  }
  try {
    added += item.kind === "pr" ? await routePrReview(ctx, item, observation, mainSha, owned) : await routeIssueReview(item, observation, mainSha);
  } finally {
    if (item.kind === "pr") {
      try { await reconcileObserved(github, item.id, item.payload.number, { subjectId: item.id }, context); }
      catch (error) { log.warn({ event: "github.review_reconciliation_pending", subjectId: item.id, err: error }); }
    }
  }
  return added;
}

export async function routeGithubTasks(github: GitHubRepository, current: Item[], previous: Map<string, Item>, log: Logger) {
  const { repository } = github;
  const repositoryPath = getRepositoryPath();
  const remote = remoteUrl(repository);
  const env = await github.getGitEnvironment();
  const ctx: SyncContext = { github, repository, repositoryPath, remote, env, log };
  const defaultBaseSha = await fetchRepository(repositoryPath, remote, config.github.baseBranch, env);
  const implemented = new Set(current.filter((item) => item.kind === "pr" && item.state === "open")
    .flatMap((item) => [...(item.payload.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)]
      .map((match) => Number(match[1]))));
  let queued = 0, deferred = 0;
  const offset = current.length ? syncRound++ % current.length : 0;
  const ordered = [...current.slice(offset), ...current.slice(0, offset)];
  const reviewable = ordered.filter((item) => item.state === "open" && item.kind === "issue" && !hasScratLabel(item));
  const contexts = await github.fetchItemContexts(reviewable.map((item) => ({ kind: "issue", number: item.payload.number, item: item.payload })), { defer: true });
  const issueContexts = new Map(reviewable.map((item, index) => [item.id, contexts[index]]));
  for (const item of ordered) {
    if (item.state === "closed") {
      await cleanupClosedItem(item);
      continue;
    }
    if (item.workspaceId && getWorkspace(item.workspaceId)?.removedAt) {
      db.update(subjects).set({ workspaceId: null }).where(eq(subjects.id, item.id)).run();
      item.workspaceId = null;
    }
    if (item.kind === "issue") {
      const previousItem = previous.get(item.externalId);
      const plan = planIssueTasks({
        labelled: Boolean(hasScratLabel(item)), implemented: implemented.has(item.payload.number), workspaceId: item.workspaceId,
        previouslyLabelled: previousItem ? Boolean(hasScratLabel(previousItem)) : undefined,
        latest: latestTask(item.id, "implement"), updatedAt: item.payload.updated_at, mainSha: defaultBaseSha,
      });
      queued += applyDecisions(item.id, plan.decisions);
      if (!plan.review) continue;
      const context = issueContexts.get(item.id);
      if (context) queued += await routeObserved(ctx, item, context, defaultBaseSha);
      else deferred++;
    } else {
      queued += await serializePr(github, item.payload.number, async () => {
        if (rateLimitLow()) { deferred++; return 0; }
        return routeObserved(ctx, item, await github.fetchItemContext("pr", item.payload.number), defaultBaseSha);
      });
    }
  }
  if (deferred) log.warn({ event: "github.sync_deferred", deferred, ...rateLimitState() }, "GitHub rate limit is low; deferred item reads to the next sync");
  return queued;
}
