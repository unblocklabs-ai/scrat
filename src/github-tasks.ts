import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { matchingActions, routeFor, workflowOf, workflows } from "./actions.ts";
import { config, getRepositoryPath, isBotLogin } from "./config.ts";
import type { Signal } from "./manifests.ts";
import { workflowItemLabelSettings } from "./workflows.ts";
import { botSlug } from "./identity.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { acknowledgedTaskIds, commentKey } from "./markers.ts";
import type { Item } from "./items.ts";
import { categoriesFor, itemLabelKey } from "./item-labels.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { labelName, reconcileLabels } from "./labels.ts";
import { db } from "./db.ts";
import { UnpublishedWorkspaceError } from "./errors.ts";
import { prepareTarget } from "./git.ts";
import { rateLimitLow, rateLimitState } from "./github-http.ts";
import { mapConcurrent, type GitHubRepository } from "./github.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import { items, runs, subjects, tasks, type Run } from "./schema.ts";
import { cancelPendingTasks, enqueueTask, latestTask, reconcileIssueImplementation } from "./tasks.ts";
import { isManual, parseTriggerInput } from "./triggers.ts";
import { getWorkspace, pruneIdleWorkspaceCaches, removeWorkspace, retainWorkspace, stripWorkspaceCaches } from "./workspaces.ts";
import { bestEffort } from "./logging.ts";
import { reconcileObserved, serializePr, type ResolvedReview } from "./pr-review-publication.ts";
import { latestCompletedRun, latestFinishedRun, latestRunOfTask, runHistory } from "./run-history.ts";
import { prReviewHistory, resolvePrReview, type PrReviewState } from "./pr-assessment.ts";
import { planKeyedTask, planPrMaintenance, planReview, planSelfRepair, reviewTrigger, type RoutingDecision } from "./github-routing.ts";
import { supersedeRunningReviews } from "./runner.ts";

type SyncContext = {
  github: GitHubRepository; log: Logger;
};
type PrMaintenanceFacts = Parameters<typeof planPrMaintenance>[0];
type Routes = { review?: string; conflicts?: string; feedback?: string; repairs: string[]; repairFor: (grade: Signal["grade"]) => string | undefined };

const signalFor = (item: Item, login: string | null | undefined, kind: Signal["kind"], grade?: Signal["grade"]): Signal =>
  ({ source: "github_items", kind, item: item.kind, author: isBotLogin(login) ? "bot" : "other", grade });
const latestOf = (subjectId: string, action: string | undefined) => action ? latestTask(subjectId, action) : undefined;

function hasScratLabel(item: Item) {
  return item.payload.labels?.some((label) => labelName(label) === botSlug) ?? false;
}

function applyDecisions(subjectId: string, decisions: RoutingDecision[]) {
  let queued = 0;
  for (const decision of decisions) {
    if (decision.type === "cancel") cancelPendingTasks(subjectId, decision.reason, decision.action, true);
    else { enqueueTask({ subjectId, action: decision.action, reason: decision.reason, input: decision.input }); queued++; }
  }
  return queued;
}

let syncRound = 0;
const limitLogged = new Set<string>();
const implementationUnchecked = new Set<string>();

async function cleanupClosedItem({ github, log }: SyncContext, item: Item) {
  cancelPendingTasks(item.id, "GitHub item closed");
  supersedeRunningReviews(item.id, "GitHub item closed");
  if (item.kind === "pr" && config.storefront.enabled) {
    const { deletePreview } = await import("./storefront.ts");
    await bestEffort(log, "storefront.delete_failed", { subjectId: item.id }, () => deletePreview(github, item.id, item.payload));
  }
  if (!item.workspaceId) return;
  const active = db.select().from(runs).where(and(eq(runs.workspaceId, item.workspaceId), isNull(runs.finishedAt))).get();
  const workspace = getWorkspace(item.workspaceId);
  if (active || !workspace || workspace.removedAt || workspace.retainedAt) return;
  const related = db.select().from(subjects).where(eq(subjects.workspaceId, workspace.id)).all();
  if (item.kind !== "pr" && related.some((linked) => linked.id !== item.id && linked.state === "open")) return;
  for (const linked of related) cancelPendingTasks(linked.id, item.kind === "pr" ? "PR merged or closed" : "Issue closed");
  try { await removeWorkspace(workspace.id, { subjectId: item.id }); }
  catch (error) {
    if (error instanceof UnpublishedWorkspaceError) {
      retainWorkspace(workspace.id, error.message, { subjectId: item.id });
      await stripWorkspaceCaches(workspace.id, workspace.path, { removeSandboxHome: true });
    }
  }
}

async function gatherPrMaintenanceFacts(ctx: SyncContext, item: Item, observation: ItemObservation, pr: GithubPullRequest, mainSha: string, routes: Routes): Promise<PrMaintenanceFacts> {
  const { github } = ctx, repositoryPath = getRepositoryPath();
  const { headSha, conflicts, behind } = await prepareTarget(repositoryPath, mainSha, await github.fetchPullRequestHead(pr));
  const lastRun = latestFinishedRun(item.id);
  const preparationFailed = behind && !conflicts && Boolean(lastRun?.error) && lastRun?.stage === "preparing" && lastRun.headSha === headSha;
  const ciBlocker = routes.conflicts && behind && !conflicts && !preparationFailed
    ? await bestEffort(ctx.log, "github.pr_ci_unavailable", { subjectId: item.id }, () => github.prCiBlocker(pr, mainSha)) : undefined;
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
    conflicts, preparationFailed, ciBlocker, mainSha, headSha, pendingComments: pending.map((comment) => commentKey(comment)),
    conflictTask: latestOf(item.id, routes.conflicts), feedbackTask: latestOf(item.id, routes.feedback),
  };
}

function repairConfigOf(name: string | undefined) {
  if (name === undefined) return undefined;
  const cfg = workflowOf(name).config;
  const rawMax = cfg.maxSelfRepairs;
  if (rawMax !== undefined && (!Number.isInteger(rawMax) || (rawMax as number) < 0)) {
    throw new Error(`${name}: config.maxSelfRepairs must be a non-negative integer`);
  }
  return {
    exhaustedLabel: typeof cfg.exhaustedLabel === "string" ? cfg.exhaustedLabel : null,
    maxSelfRepairs: rawMax as number | undefined,
  };
}

async function reconcileExhaustedLabel(ctx: SyncContext, item: Item, observation: ItemObservation, routes: Routes, repair: string | undefined, state: PrReviewState, count: number) {
  const name = repair ?? routes.repairs[0], settings = repairConfigOf(name);
  const latestRepair = latestOf(item.id, name);
  const repairActive = latestRepair?.status === "queued" || latestRepair?.status === "running";
  if (!settings?.exhaustedLabel || !routes.repairs.length || state.kind !== "current" || repairActive) return;
  const { exhaustedLabel } = settings;
  const exhausted = repair !== undefined && settings.maxSelfRepairs !== undefined && count >= settings.maxSelfRepairs;
  await bestEffort(ctx.log, "github.label_pending", { subjectId: item.id }, () => reconcileLabels(ctx.github, item.payload.number, { current: observation.labels, desired: exhausted ? [exhaustedLabel] : [], managed: [exhaustedLabel] }, { subjectId: item.id }));
}

async function reconcileFailedLabels(ctx: SyncContext, item: Item) {
  const labelled = workflows.flatMap((wf) => {
    const resolved = workflowOf(wf.name);
    const label = typeof resolved.config.failedLabel === "string" && resolved.config.failedLabel ? resolved.config.failedLabel : undefined;
    return resolved.on.event?.item === item.kind && label ? [{ name: wf.name, label, selected: resolved.on.event.kind !== "label" || hasScratLabel(item) }] : [];
  });
  if (!labelled.length) return;
  await bestEffort(ctx.log, "github.label_pending", { subjectId: item.id }, () => reconcileLabels(ctx.github, item.payload.number, {
    current: item.payload.labels ?? [],
    desired: labelled.filter(({ name, selected }) => selected && latestTask(item.id, name)?.status === "failed").map(({ label }) => label),
    managed: labelled.map(({ label }) => label),
  }, { subjectId: item.id }));
}

function conflictMergePreservesLabel(subjectId: string, pr: GithubPullRequest, latestRun: Run, categories: ReturnType<typeof categoriesFor>) {
  const previousHead = latestRun.context?.headSha;
  if (!previousHead || !latestRun.context?.labeling?.key) return false;
  if (pr.head.sha === previousHead) return false;
  if (itemLabelKey({ ...pr, head: { ...pr.head, sha: previousHead } }, categories) !== latestRun.context.labeling.key) return false;
  const conflictActions = workflows.filter((wf) => wf.on.event?.kind === "pr_conflicts").map((wf) => wf.name);
  if (!conflictActions.length) return false;
  const merges = new Map<string, string>();
  const rows = db.select({
    headSha: sql<string | null>`json_extract(${runs.context}, '$.headSha')`,
    publishedCommitSha: sql<string | null>`json_extract(${runs.publication}, '$.publishedCommitSha')`,
  }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), inArray(tasks.action, conflictActions), eq(tasks.status, "completed"), isNull(runs.error), isNull(runs.piSessionId))).all();
  for (const { headSha, publishedCommitSha } of rows) {
    if (publishedCommitSha && headSha && publishedCommitSha !== headSha) merges.set(publishedCommitSha, headSha);
  }
  let current: string | undefined = pr.head.sha;
  const visited = new Set<string>();
  while (current && current !== previousHead && !visited.has(current)) {
    visited.add(current);
    current = merges.get(current);
  }
  return current === previousHead;
}

function routeItemLabels(item: Item) {
  let queued = 0;
  for (const action of matchingActions(signalFor(item, item.payload.user?.login, "item_labels"))) {
    const resolved = workflowOf(action);
    const categories = resolved.enabled ? categoriesFor(workflowItemLabelSettings(resolved), item.kind) : [];
    if (!categories.length) {
      cancelPendingTasks(item.id, "Item labeling disabled for this kind", action);
      supersedeRunningReviews(item.id, "Item labeling disabled for this kind", { action });
      continue;
    }
    const triggerKey = itemLabelKey(item.payload, categories);
    const latest = latestTask(item.id, action);
    const latestRun = latest && latest.status !== "queued" ? latestRunOfTask(latest.id) : undefined;
    const evaluatedKey = latestRun?.context?.labeling?.key;
    if ("head" in item.payload && latest?.status === "completed" && latestRun && !latestRun.error
      && conflictMergePreservesLabel(item.id, item.payload, latestRun, categories)) continue;
    queued += applyDecisions(item.id, planKeyedTask(latest, action, latest ? "Item or label policy changed" : "Initial item labeling (backfill)", { source: "github_items", kind: "item_labels", triggerKey }, evaluatedKey));
  }
  return queued;
}

async function routePrReview(ctx: SyncContext, item: Item, observation: ItemObservation, mainSha: string, routes: Routes) {
  const action = routes.review;
  if (!action) return { added: 0 };
  const latest = latestTask(item.id, action);
  const conflictTask = latestOf(item.id, routes.conflicts);
  const conflictPending = conflictTask?.status === "queued" || conflictTask?.status === "running";
  const reviews = prReviewHistory(item.id);
  const attempt = reviews.find(({ task }) => task.id === latest?.id)?.run;
  const state = await resolvePrReview(reviews, observation, mainSha);
  let added = applyDecisions(item.id, planReview({ kind: "pr", action, state, latest, attempt, revision: observation.revision, mainSha, conflictPending }));
  if (conflictPending) supersedeRunningReviews(item.id, "PR branch refresh is pending", { action, keepManual: true });
  else if (state.kind === "blocked") supersedeRunningReviews(item.id, "PR conflicts with its base branch; waiting for a new head", { action, keepManual: true });
  else if (state.kind === "current") supersedeRunningReviews(item.id, "No observed relevant changes since the authoritative review", { action, keepManual: true });
  else if ("head" in observation.item) supersedeRunningReviews(item.id, "Newer PR head or base observed", {
    action, keepManual: true, unlessTarget: `${observation.item.head.sha}@${observation.baseBranch}`,
  });
  const count = db.select({ count: items.selfRepairCount }).from(items).where(eq(items.id, item.id)).get()!.count;
  const repairAction = routes.repairFor(state.kind === "current" ? state.assessment.result.grade : undefined);
  const limit = repairConfigOf(repairAction)?.maxSelfRepairs;
  const repair = planSelfRepair({
    repairAction, repairActions: routes.repairs, state, feedbackTask: latestOf(item.id, routes.feedback),
    conflictTask, reviewTask: latest, repairTask: latestOf(item.id, repairAction), count, limit,
  });
  if (repair.limited && state.kind === "current" && !limitLogged.has(state.assessment.originId)) {
    limitLogged.add(state.assessment.originId);
    ctx.log.info({ event: "self_repair.limit_reached", subjectId: item.id, limit }, "Self-repair limit reached");
  }
  added += applyDecisions(item.id, repair.decisions);
  await reconcileExhaustedLabel(ctx, item, observation, routes, repairAction, state, count);
  return { added, resolved: { reviews, state, mainSha } };
}

async function routeIssueReview(item: Item, observation: ItemObservation, mainSha: string, action: string | undefined) {
  if (!action) return 0;
  const latest = latestTask(item.id, action);
  const attempt = latest ? latestRunOfTask(latest.id) : undefined;
  const { revision } = observation;
  if (reviewTrigger({ latest, attempt, revision, mainSha }).covered) return 0;
  const completed = latestCompletedRun(item.id, action);
  const state = completed ? await freshness(savedEvaluation(completed), { ...observation, mainSha }, "relevant-paths") : undefined;
  return applyDecisions(item.id, planReview({ kind: "issue", action, completed, freshness: state, latest, attempt, revision, mainSha }));
}

async function routeObserved(ctx: SyncContext, item: Item, context: GithubContext, defaultBaseSha: string) {
  if (context.item.state !== "open") return 0;
  const { github, log } = ctx;
  const observation = observe(context);
  const mainSha = observation.kind === "pr" && observation.baseBranch !== config.github.baseBranch
    ? await github.fetchBranch(observation.baseBranch) : defaultBaseSha;
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
    const pullRequest = context.item;
    if (pullRequest.head.repo?.full_name !== github.repository) return added;
    if (routes.conflicts || routes.feedback) {
      added += await bestEffort(log, "github.pr_maintenance_skipped", { subjectId: item.id }, async () => applyDecisions(item.id, planPrMaintenance(await gatherPrMaintenanceFacts(ctx, item, observation, pullRequest, mainSha, routes)))) ?? 0;
    }
  }
  let resolved: ResolvedReview | undefined;
  try {
    if (item.kind === "pr") {
      const routed = await routePrReview(ctx, item, observation, mainSha, routes);
      added += routed.added;
      resolved = routed.resolved;
    } else added += await routeIssueReview(item, observation, mainSha, routes.review);
  } finally {
    if (item.kind === "pr") await bestEffort(log, "github.review_reconciliation_pending", { subjectId: item.id }, () => reconcileObserved(github, item.id, item.payload.number, { subjectId: item.id }, context, resolved));
  }
  return added;
}

export async function routeGithubTasks(github: GitHubRepository, current: Item[], previous: Map<string, Item>, log: Logger) {
  const ctx: SyncContext = { github, log };
  const defaultBaseSha = await github.fetchBranch(config.github.baseBranch);
  let queued = 0, deferred = 0;
  const offset = current.length ? syncRound++ % current.length : 0;
  const ordered = [...current.slice(offset), ...current.slice(0, offset)];
  const issueSignal = (item: Item, kind: Signal["kind"]) => signalFor(item, item.payload.user?.login, kind);
  const selects = (item: Item) => hasScratLabel(item) && routeFor(issueSignal(item, "label")) !== undefined;
  const reviewable = ordered.filter((item) => item.state === "open" && item.kind === "issue" && !selects(item));
  const contexts = await github.fetchItemContexts(reviewable.map((item) => ({ kind: "issue", number: item.payload.number, item: item.payload })));
  const issueContexts = new Map(reviewable.map((item, index) => [item.id, contexts[index]]));
  const routeItem = async (item: Item) => {
    if (item.state === "closed") {
      implementationUnchecked.delete(item.id);
      await cleanupClosedItem(ctx, item);
      return;
    }
    queued += routeItemLabels(item);
    const workspace = item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
    if (workspace && (workspace.removedAt || workspace.retainedAt)) {
      const detached = db.update(subjects).set({ workspaceId: null })
        .where(and(eq(subjects.id, item.id), eq(subjects.workspaceId, workspace.id))).returning({ id: subjects.id }).get();
      item.workspaceId = detached ? null : db.select({ workspaceId: subjects.workspaceId }).from(subjects).where(eq(subjects.id, item.id)).get()?.workspaceId ?? null;
    }
    await reconcileFailedLabels(ctx, item);
    if (item.kind === "issue") {
      const previousItem = previous.get(item.externalId);
      const labelAction = routeFor(issueSignal(item, "label"));
      const selected = hasScratLabel(item);
      const latest = latestOf(item.id, labelAction);
      if (labelAction && (selected || latest?.status === "blocked" && isManual(latest.input))) {
        const reviewAction = routeFor(issueSignal(item, "item_changed"));
        if (selected && reviewAction) {
          cancelPendingTasks(item.id, "Issue selected for implementation", reviewAction, true);
          supersedeRunningReviews(item.id, "Issue selected for implementation", { action: reviewAction, keepManual: true });
        }
        const newlySelected = previousItem !== undefined && !hasScratLabel(previousItem);
        const settled = latest && latest.status !== "queued" && latest.status !== "blocked" && latest.status !== "cancelled";
        if (selected && settled && !newlySelected && !implementationUnchecked.has(item.id)
          && previousItem?.state === "open" && previousItem.payload.updated_at === item.payload.updated_at) return;
        implementationUnchecked.add(item.id);
        const own = item.workspaceId ? getWorkspace(item.workspaceId)?.branch : undefined;
        if (rateLimitLow() || rateLimitLow("graphql")) { deferred++; return; }
        const observedAt = new Date().toISOString();
        const facts = await github.issueImplementation(item.payload.number, config.github.baseBranch, own);
        const triggerKey = JSON.stringify({ labelledAt: item.payload.updated_at, mainSha: defaultBaseSha });
        if (reconcileIssueImplementation({ subjectId: item.id, action: labelAction, observedTask: latest, observedAt, facts,
          input: { source: "github_items", kind: "label", triggerKey, mainSha: defaultBaseSha },
          selected, newlySelected,
        })) queued++;
        implementationUnchecked.delete(item.id);
        if (selected) return;
      }
      if (labelAction) cancelPendingTasks(item.id, `${botSlug} label removed`, labelAction, true);
      const context = issueContexts.get(item.id);
      if (context) {
        const added = await routeObserved(ctx, item, context, defaultBaseSha);
        queued += added;
      } else deferred++;
    } else {
      const added = await serializePr(github, item.payload.number, async () => {
        if (rateLimitLow()) { deferred++; return 0; }
        return routeObserved(ctx, item, await github.fetchItemContext("pr", item.payload.number), defaultBaseSha);
      });
      queued += added;
    }
  };
  const closed = ordered.filter((item) => item.state === "closed");
  const open = ordered.filter((item) => item.state !== "closed");
  for (const item of closed) {
    await bestEffort(log, "github.routing_failed", { subjectId: item.id }, () => routeItem(item));
  }
  await mapConcurrent(open, async (item) => {
    await bestEffort(log, "github.routing_failed", { subjectId: item.id }, () => routeItem(item));
  });
  if (syncRound % 12 === 1) {
    await bestEffort(log, "workspaces.prune_caches_failed", {}, () => pruneIdleWorkspaceCaches());
  }
  if (deferred) log.warn({ event: "github.sync_deferred", deferred, ...rateLimitState(), graphql: rateLimitState("graphql") }, "GitHub rate limit is low; deferred item reads to the next sync");
  return queued;
}
