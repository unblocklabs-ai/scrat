import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { config, getRepositoryPath } from "./config.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { acknowledgedTaskIds } from "./markers.ts";
import { observe, remoteUrl } from "./observation.ts";
import { labelName } from "./labels.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts } from "./git.ts";
import { rateLimitLow, rateLimitState, type GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { items, runs, tasks } from "./schema.ts";
import { cancelQueuedTasks, enqueueTask } from "./tasks.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";
import { reconcileObserved, serializePr } from "./pr-review-publication.ts";
import { prReviewHistory, resolvePrReview } from "./pr-assessment.ts";
import { planIssueTasks, planPrMaintenance, planReview, reviewTrigger, type RoutingDecision } from "./github-routing.ts";

type Item = typeof items.$inferSelect;
type Action = typeof tasks.$inferSelect.action;

function latestTask(itemId: string, action: Action) {
  return db.select().from(tasks).where(and(eq(tasks.itemId, itemId), eq(tasks.action, action)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1).get();
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry: unknown): entry is string => typeof entry === "string");
}

function hasScratLabel(item: Item) {
  return item.payload.labels?.some((label) => labelName(label) === "scrat");
}

function applyDecisions(itemId: string, decisions: RoutingDecision[]) {
  let queued = 0;
  for (const decision of decisions) {
    if (decision.type === "cancel") cancelQueuedTasks(itemId, decision.reason, decision.action);
    else { enqueueTask({ itemId, action: decision.action, reason: decision.reason, input: decision.input }); queued++; }
  }
  return queued;
}

let syncRound = 0;

export async function routeGithubTasks(github: GitHubRepository, current: Item[], previous: Map<string, Item>, log: Logger) {
  const { repository } = github;
  const repositoryPath = getRepositoryPath();
  const remote = remoteUrl(repository);
  const env = await github.getGitEnvironment();
  const defaultBaseSha = await fetchRepository(repositoryPath, remote, config.github.baseBranch, env);
  const implemented = new Set(current.filter((item) => item.kind === "pr" && item.state === "open")
    .flatMap((item) => [...(item.payload.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)]
      .map((match) => Number(match[1]))));
  let queued = 0, deferred = 0;
  // Start each sync at a different item so a low budget never starves the same tail. Deferring a PR also defers its
  // sync-driven reconciliation (worker publication reconciles on its own and is never deferred).
  const offset = current.length ? syncRound++ % current.length : 0;
  const ordered = [...current.slice(offset), ...current.slice(0, offset)];
  // Issue metadata is already fresh from this sync's list response; only the discussion is read, up to four at a time.
  // PR contexts are read one at a time inside each PR's review lock.
  const reviewable = ordered.filter((item) => item.state === "open" && item.kind === "issue" && !hasScratLabel(item));
  const contexts = await github.fetchItemContexts(reviewable.map((item) => ({ kind: "issue", number: item.payload.number, item: item.payload })), { defer: true });
  const issueContexts = new Map(reviewable.map((item, index) => [item.id, contexts[index]]));
  // Routes one open item from an observation; for a PR the caller holds its review lock.
  const routeObserved = async (item: Item, context: GithubContext, defaultSha: string) => {
    let mainSha = defaultSha, added = 0;
    if (context.item.state !== "open") return added;
    const observation = observe(repository, context);
    if (observation.kind === "pr" && observation.baseBranch !== config.github.baseBranch) {
      mainSha = await fetchRepository(repositoryPath, remote, observation.baseBranch, env);
    }
    const { external: comments, revision } = observation;
    const owned = item.kind === "pr" && context.item.user?.login === config.github.botLogin;
    if (owned && "head" in context.item) {
      const pr = context.item;
      if (pr.head.repo?.full_name !== repository) return added;
      const headRef = await fetchPullRequestHead(repositoryPath, remote, pr.number, env);
      const headSha = await git(repositoryPath, ["rev-parse", headRef]);
      const conflicts = await hasConflicts(repositoryPath, mainSha, headSha);
      const acknowledged = new Set(observation.own.flatMap((comment) => acknowledgedTaskIds(comment.body)));
      const handled = db.select({ run: runs, task: tasks }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(and(eq(tasks.itemId, item.id), eq(tasks.action, "address_pr_feedback"))).all()
        .filter(({ run, task }) => (!run.finishedAt && task.status === "running") || (run.finishedAt && !run.error)
          || run.publication.commentId || acknowledged.has(task.id));
      const consumed = new Set(handled.flatMap(({ run }) => run.context?.commentRevisions ?? strings(run.input.commentRevisions)));
      const pending = comments.filter((comment) => !consumed.has(`${comment.id}@${comment.revision}`));
      added += applyDecisions(item.id, planPrMaintenance({
        conflicts, mainSha, headSha, pendingComments: pending.map((comment) => `${comment.id}@${comment.revision}`),
        conflictTask: latestTask(item.id, "resolve_conflicts"), feedbackTask: latestTask(item.id, "address_pr_feedback"),
      }));
    }
    try {
      const action = item.kind === "issue" ? "review_issue" : "review_pr";
      const latest = latestTask(item.id, action);
      const reviews = item.kind === "pr" ? prReviewHistory(item.id) : undefined;
      const attempt = reviews ? reviews.find(({ task }) => task.id === latest?.id)?.run
        : latest ? db.select().from(runs).where(eq(runs.taskId, latest.id))
          .orderBy(desc(runs.startedAt)).limit(1).get() : undefined;
      if (reviews) {
        const state = await resolvePrReview(reviews, observation, mainSha);
        added += applyDecisions(item.id, planReview({ kind: "pr", state, latest, attempt, revision, mainSha }));
      } else {
        if (reviewTrigger({ latest, attempt, revision, mainSha }).covered) return added;
        const completed = db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
          .where(and(eq(tasks.itemId, item.id), eq(tasks.action, action), eq(tasks.status, "completed"), isNull(runs.error)))
          .orderBy(desc(runs.startedAt)).limit(1).get()?.run;
        const state = completed ? await freshness(savedEvaluation(completed), { ...observation, mainSha }, "relevant-paths") : undefined;
        added += applyDecisions(item.id, planReview({ kind: "issue", completed, freshness: state, latest, attempt, revision, mainSha }));
      }
    } finally {
      if (item.kind === "pr") {
        try { await reconcileObserved(github, item.id, item.payload.number, { itemId: item.id }, context); }
        catch (error) { log.warn({ event: "github.review_reconciliation_pending", itemId: item.id, err: error }); }
      }
    }
    return added;
  };
  for (const item of ordered) {
    let mainSha = defaultBaseSha;
    if (item.state === "closed") {
      cancelQueuedTasks(item.id, "GitHub item closed");
      if (item.kind === "pr" && item.workspaceId) {
        const active = db.select().from(runs).where(and(eq(runs.workspaceId, item.workspaceId), isNull(runs.finishedAt))).get();
        const workspace = getWorkspace(item.workspaceId);
        if (!active && workspace && !workspace.removedAt) {
          const related = db.select().from(items).where(eq(items.workspaceId, workspace.id)).all();
          for (const linked of related) cancelQueuedTasks(linked.id, "PR merged or closed");
          try { await removeWorkspace(workspace.id, { itemId: item.id }); }
          catch { /* Cleanup logs the failure and retains the work; keep routing unrelated items. */ }
        }
      }
      continue;
    }
    if (item.workspaceId && getWorkspace(item.workspaceId)?.removedAt) {
      db.update(items).set({ workspaceId: null }).where(eq(items.id, item.id)).run();
      item.workspaceId = null;
    }
    if (item.kind === "issue") {
      const previousItem = previous.get(item.externalId);
      const plan = planIssueTasks({
        labelled: Boolean(hasScratLabel(item)), implemented: implemented.has(item.payload.number), workspaceId: item.workspaceId,
        previouslyLabelled: previousItem ? Boolean(hasScratLabel(previousItem)) : undefined,
        latest: latestTask(item.id, "implement"), updatedAt: item.payload.updated_at, mainSha,
      });
      queued += applyDecisions(item.id, plan.decisions);
      if (!plan.review) continue;
    }
    if (item.kind === "issue") {
      const context = issueContexts.get(item.id);
      if (context) queued += await routeObserved(item, context, mainSha);
      else deferred++;
    } else {
      // One observation per sync, taken inside the PR's lock: reconciliation reuses it, so a comment
      // published by a worker meanwhile cannot be missed. Workers wait on the lock, never the reverse.
      queued += await serializePr(github, item.payload.number, async () => {
        if (rateLimitLow()) { deferred++; return 0; }
        return routeObserved(item, await github.fetchItemContext("pr", item.payload.number), mainSha);
      });
    }
  }
  if (deferred) log.warn({ event: "github.sync_deferred", deferred, ...rateLimitState() }, "GitHub rate limit is low; deferred item reads to the next sync");
  return queued;
}
