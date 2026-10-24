import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { manifests, matchingActions, routeFor } from "./actions.ts";
import { config, getRepositoryPath, isBotLogin } from "./config.ts";
import type { Signal } from "./manifests.ts";
import { botSlug } from "./identity.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { acknowledgedTaskIds, commentKey } from "./markers.ts";
import type { Item } from "./items.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { remoteUrl } from "./repository.ts";
import { labelName, reconcileLabels } from "./labels.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, prepareTarget } from "./git.ts";
import { rateLimitLow, rateLimitState } from "./github-http.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import { items, runs, subjects } from "./schema.ts";
import { cancelQueuedTasks, enqueueTask, latestTask } from "./tasks.ts";
import { parseTriggerInput } from "./triggers.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";
import { reconcileObserved, serializePr } from "./pr-review-publication.ts";
import { completedRunsOfAction, latestFinishedRun, latestRunOfTask, runHistory } from "./run-history.ts";
import { prReviewHistory, resolvePrReview, type PrReviewState } from "./pr-assessment.ts";
import { planIssueTasks, planPrMaintenance, planReview, planSelfRepair, reviewTrigger, type RoutingDecision } from "./github-routing.ts";

type SyncContext = {
  github: GitHubRepository; repository: string; repositoryPath: string; remote: string;
  env: Awaited<ReturnType<GitHubRepository["getGitEnvironment"]>>; log: Logger;
};
type PrMaintenanceFacts = Parameters<typeof planPrMaintenance>[0];
type Routes = { review?: string; conflicts?: string; feedback?: string; repairs: string[]; repairFor: (grade: Signal["grade"]) => string | undefined };

const signalFor = (item: Item, login: string | null | undefined, kind: Signal["kind"], grade?: Signal["grade"]): Signal =>
  ({ source: "github_items", kind, item: item.kind, author: isBotLogin(login) ? "bot" : "other", grade });
const latestOf = (subjectId: string, action: string | undefined) => action ? latestTask(subjectId, action) : undefined;

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

async function gatherPrMaintenanceFacts(ctx: SyncContext, item: Item, observation: ItemObservation, pr: GithubPullRequest, mainSha: string, routes: Routes): Promise<PrMaintenanceFacts> {
  const { repositoryPath, remote, env } = ctx;
  const { headSha, conflicts, behind } = await prepareTarget(repositoryPath, mainSha, await fetchPullRequestHead(repositoryPath, remote, pr.number, pr.head.sha, env));
  const lastRun = latestFinishedRun(item.id);
  const stale = !conflicts && Boolean(lastRun?.error) && lastRun?.stage === "preparing" && lastRun.headSha === headSha && behind;
  const acknowledged = new Set(observation.own.flatMap((comment) => acknowledgedTaskIds(comment.body)));
  const handled = (routes.feedback ? runHistory(item.id, routes.feedback) : [])
    .filter(({ run, task }) => (!run.finishedAt && task.status === "running") || (run.finishedAt && !run.error)
      || run.publication.commentId || acknowledged.has(task.id));
  const consumed = new Set(handled.flatMap(({ run }) => {
    if (run.context) return run.context.commentRevisions;
    const trigger = parseTriggerInput(run.input);
    return trigger.kind === "pr_feedback" ? trigger.commentRevisions : [];
  }));
  const pending = observation.external.filter((comment) => !consumed.has(commentKey(comment)));
  return {
    conflictAction: routes.conflicts, feedbackAction: routes.feedback,
    conflicts, stale, mainSha, headSha, pendingComments: pending.map((comment) => commentKey(comment)),
    conflictTask: latestOf(item.id, routes.conflicts), feedbackTask: latestOf(item.id, routes.feedback),
  };
}

async function reconcileExhaustedLabel(ctx: SyncContext, item: Item, observation: ItemObservation, routes: Routes, repair: string | undefined, state: PrReviewState, count: number) {
  const settings = config.actions[repair ?? routes.repairs[0] ?? ""];
  const latestRepair = latestOf(item.id, repair ?? routes.repairs[0]);
  const repairActive = latestRepair?.status === "queued" || latestRepair?.status === "running";
  if (!settings?.exhaustedLabel || !routes.repairs.length || state.kind !== "current" || repairActive) return;
  const { exhaustedLabel } = settings;
  const exhausted = repair !== undefined && settings.maxSelfRepairs !== undefined && count >= settings.maxSelfRepairs;
  try {
    await reconcileLabels(ctx.github, item.payload.number, { current: observation.labels, desired: exhausted ? [exhaustedLabel] : [], managed: [exhaustedLabel] }, { subjectId: item.id });
  } catch (error) { ctx.log.warn({ event: "github.label_pending", subjectId: item.id, err: error }); }
}

async function reconcileFailedLabels(ctx: SyncContext, item: Item) {
  const labelled = manifests.flatMap(({ name, trigger }) => {
    const label = config.actions[name]?.failedLabel;
    return trigger.item === item.kind && label ? [{ name, label, selected: trigger.kind !== "label" || hasScratLabel(item) }] : [];
  });
  if (!labelled.length) return;
  try {
    await reconcileLabels(ctx.github, item.payload.number, {
      current: item.payload.labels ?? [],
      desired: labelled.filter(({ name, selected }) => selected && latestTask(item.id, name)?.status === "failed").map(({ label }) => label),
      managed: labelled.map(({ label }) => label),
    }, { subjectId: item.id });
  } catch (error) { ctx.log.warn({ event: "github.label_pending", subjectId: item.id, err: error }); }
}

async function routePrReview(ctx: SyncContext, item: Item, observation: ItemObservation, mainSha: string, routes: Routes) {
  const action = routes.review;
  if (!action) return 0;
  const latest = latestTask(item.id, action);
  const reviews = prReviewHistory(item.id);
  const attempt = reviews.find(({ task }) => task.id === latest?.id)?.run;
  const state = await resolvePrReview(reviews, observation, mainSha);
  let added = applyDecisions(item.id, planReview({ kind: "pr", action, state, latest, attempt, revision: observation.revision, mainSha }));
  const count = db.select({ count: items.selfRepairCount }).from(items).where(eq(items.id, item.id)).get()!.count;
  const repairAction = routes.repairFor(state.kind === "current" ? state.assessment.result.grade : undefined);
  const limit = config.actions[repairAction ?? ""]?.maxSelfRepairs;
  const repair = planSelfRepair({
    repairAction, repairActions: routes.repairs, state, feedbackTask: latestOf(item.id, routes.feedback),
    reviewTask: latest, repairTask: latestOf(item.id, repairAction), count, limit,
  });
  if (repair.limited && state.kind === "current" && !limitLogged.has(state.assessment.originId)) {
    limitLogged.add(state.assessment.originId);
    ctx.log.info({ event: "self_repair.limit_reached", subjectId: item.id, limit }, "Self-repair limit reached");
  }
  added += applyDecisions(item.id, repair.decisions);
  await reconcileExhaustedLabel(ctx, item, observation, routes, repairAction, state, count);
  return added;
}

async function routeIssueReview(item: Item, observation: ItemObservation, mainSha: string, action: string | undefined) {
  if (!action) return 0;
  const latest = latestTask(item.id, action);
  const attempt = latest ? latestRunOfTask(latest.id) : undefined;
  const { revision } = observation;
  if (reviewTrigger({ latest, attempt, revision, mainSha }).covered) return 0;
  const completed = completedRunsOfAction(item.id, action, 1)[0];
  const state = completed ? await freshness(savedEvaluation(completed), { ...observation, mainSha }, "relevant-paths") : undefined;
  return applyDecisions(item.id, planReview({ kind: "issue", action, completed, freshness: state, latest, attempt, revision, mainSha }));
}

async function routeObserved(ctx: SyncContext, item: Item, context: GithubContext, defaultBaseSha: string) {
  if (context.item.state !== "open") return 0;
  const { github, repository, repositoryPath, remote, env, log } = ctx;
  const observation = observe(repository, context);
  const mainSha = observation.kind === "pr" && observation.baseBranch !== config.github.baseBranch
    ? await fetchRepository(repositoryPath, remote, observation.baseBranch, env) : defaultBaseSha;
  const login = context.item.user?.login, signal = (kind: Signal["kind"]) => signalFor(item, login, kind);
  const routes: Routes = {
    review: routeFor(signal("item_changed")),
    ...item.kind === "pr" ? {
      conflicts: routeFor(signal("pr_conflicts")), feedback: routeFor(signal("pr_feedback")),
    } : {},
    repairs: item.kind === "pr" ? matchingActions(signal("low_grade")) : [],
    repairFor: (grade) => grade ? routeFor({ ...signal("low_grade"), grade }) : undefined,
  };
  let added = 0;
  if ((routes.conflicts || routes.feedback || routes.repairs.length) && "head" in context.item) {
    if (context.item.head.repo?.full_name !== repository) return added;
    if (routes.conflicts || routes.feedback) {
      try { added += applyDecisions(item.id, planPrMaintenance(await gatherPrMaintenanceFacts(ctx, item, observation, context.item, mainSha, routes))); }
      catch (error) { log.warn({ event: "github.pr_maintenance_skipped", subjectId: item.id, err: error }); }
    }
  }
  try {
    added += item.kind === "pr" ? await routePrReview(ctx, item, observation, mainSha, routes) : await routeIssueReview(item, observation, mainSha, routes.review);
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
  const issueSignal = (item: Item, kind: Signal["kind"]) => signalFor(item, item.payload.user?.login, kind);
  const selects = (item: Item) => hasScratLabel(item) && routeFor(issueSignal(item, "label")) !== undefined;
  const reviewable = ordered.filter((item) => item.state === "open" && item.kind === "issue" && !selects(item));
  const contexts = await github.fetchItemContexts(reviewable.map((item) => ({ kind: "issue", number: item.payload.number, item: item.payload })), { defer: true });
  const issueContexts = new Map(reviewable.map((item, index) => [item.id, contexts[index]]));
  const routeItem = async (item: Item) => {
    if (item.state === "closed") {
      await cleanupClosedItem(item);
      return;
    }
    if (item.workspaceId && getWorkspace(item.workspaceId)?.removedAt) {
      db.update(subjects).set({ workspaceId: null }).where(eq(subjects.id, item.id)).run();
      item.workspaceId = null;
    }
    await reconcileFailedLabels(ctx, item);
    if (item.kind === "issue") {
      const previousItem = previous.get(item.externalId);
      const labelAction = routeFor(issueSignal(item, "label"));
      const plan = planIssueTasks({
        labelAction, reviewAction: routeFor(issueSignal(item, "item_changed")), labelled: Boolean(hasScratLabel(item)), implemented: implemented.has(item.payload.number), workspaceId: item.workspaceId,
        previouslyLabelled: previousItem ? Boolean(hasScratLabel(previousItem)) : undefined,
        latest: latestOf(item.id, labelAction), updatedAt: item.payload.updated_at, mainSha: defaultBaseSha,
      });
      queued += applyDecisions(item.id, plan.decisions);
      if (!plan.review) return;
      const context = issueContexts.get(item.id);
      if (context) queued += await routeObserved(ctx, item, context, defaultBaseSha);
      else deferred++;
    } else {
      queued += await serializePr(github, item.payload.number, async () => {
        if (rateLimitLow()) { deferred++; return 0; }
        return routeObserved(ctx, item, await github.fetchItemContext("pr", item.payload.number), defaultBaseSha);
      });
    }
  };
  for (const item of ordered) {
    try { await routeItem(item); }
    catch (error) { log.warn({ event: "github.routing_failed", subjectId: item.id, err: error }); }
  }
  if (deferred) log.warn({ event: "github.sync_deferred", deferred, ...rateLimitState() }, "GitHub rate limit is low; deferred item reads to the next sync");
  return queued;
}
