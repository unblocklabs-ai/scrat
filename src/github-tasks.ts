import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { config, getRepositoryPath } from "./config.ts";
import { reviewChanges } from "./relevance.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts } from "./git.ts";
import { githubRevision, type GitHubRepository } from "./github.ts";
import { items, runs, tasks } from "./schema.ts";
import { cancelQueuedTasks, enqueueTask } from "./tasks.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";
import { reconcilePrReview } from "./pr-review-state.ts";
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
  return item.payload.labels?.some((label) => typeof label === "string" ? label === "scrat" : label.name === "scrat");
}

function applyDecisions(itemId: string, decisions: RoutingDecision[]) {
  let queued = 0;
  for (const decision of decisions) {
    if (decision.type === "cancel") cancelQueuedTasks(itemId, decision.reason, decision.action);
    else { enqueueTask({ itemId, action: decision.action, reason: decision.reason, input: decision.input }); queued++; }
  }
  return queued;
}

export async function routeGithubTasks(github: GitHubRepository, current: Item[], previous: Map<string, Item>, log: Logger) {
  const { repository } = github;
  const repositoryPath = getRepositoryPath();
  const remote = `https://github.com/${repository}.git`;
  const env = await github.getGitEnvironment();
  const defaultBaseSha = await fetchRepository(repositoryPath, remote, config.github.baseBranch, env);
  const implemented = new Set(current.filter((item) => item.kind === "pr" && item.state === "open")
    .flatMap((item) => [...(item.payload.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)]
      .map((match) => Number(match[1]))));
  let queued = 0;
  const reviewable = current.filter((item) => item.state === "open" && (item.kind === "pr" || !hasScratLabel(item)));
  const contexts = await github.fetchItemContexts(reviewable.map((item) => ({ kind: item.kind, number: item.payload.number })));
  const byId = new Map(reviewable.map((item, index) => [item.id, contexts[index]]));
  for (const item of current) {
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
    const context = byId.get(item.id)!;
    if (context.item.state !== "open") continue;
    if ("head" in context.item && context.item.base.ref !== config.github.baseBranch) {
      mainSha = await fetchRepository(repositoryPath, remote, context.item.base.ref, env);
    }
    const comments = context.comments.filter((comment) => comment.author !== config.github.botLogin && comment.body.trim());
    const owned = item.kind === "pr" && context.item.user?.login === config.github.botLogin;
    if (owned && "head" in context.item) {
      const pr = context.item;
      if (pr.head.repo?.full_name !== repository) continue;
      const headRef = await fetchPullRequestHead(repositoryPath, remote, pr.number, env);
      const headSha = await git(repositoryPath, ["rev-parse", headRef]);
      const conflicts = await hasConflicts(repositoryPath, mainSha, headSha);
      const acknowledged = new Set(context.comments.filter((comment) => comment.author === config.github.botLogin)
        .flatMap((comment) => [...comment.body.matchAll(/<!-- scrat-task:([a-f0-9-]+) -->/g)].map((match) => match[1])));
      const handled = db.select({ run: runs, task: tasks }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(and(eq(tasks.itemId, item.id), eq(tasks.action, "address_pr_feedback"))).all()
        .filter(({ run, task }) => (!run.finishedAt && task.status === "running") || (run.finishedAt && !run.error)
          || run.publication.commentId || acknowledged.has(task.id));
      const consumed = new Set(handled.flatMap(({ run }) => run.context?.commentRevisions ?? strings(run.input.commentRevisions)));
      const pending = comments.filter((comment) => !consumed.has(`${comment.id}@${comment.revision}`));
      queued += applyDecisions(item.id, planPrMaintenance({
        conflicts, mainSha, headSha, pendingComments: pending.map((comment) => `${comment.id}@${comment.revision}`),
        conflictTask: latestTask(item.id, "resolve_conflicts"), feedbackTask: latestTask(item.id, "address_pr_feedback"),
      }));
    }
    try {
      const action = item.kind === "issue" ? "review_issue" : "review_pr";
      const revision = githubRevision(context.item, comments);
      const latest = latestTask(item.id, action);
      const reviews = item.kind === "pr" ? prReviewHistory(item.id) : undefined;
      const attempt = reviews ? reviews.find(({ task }) => task.id === latest?.id)?.run
        : latest ? db.select().from(runs).where(eq(runs.taskId, latest.id))
          .orderBy(desc(runs.startedAt)).limit(1).get() : undefined;
      if (reviews) {
        const state = await resolvePrReview(reviews, context, mainSha);
        queued += applyDecisions(item.id, planReview({ kind: "pr", state, latest, attempt, revision, mainSha }));
      } else {
        if (reviewTrigger({ latest, attempt, revision, mainSha }).covered) continue;
        const completed = db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
          .where(and(eq(tasks.itemId, item.id), eq(tasks.action, action), eq(tasks.status, "completed"), isNull(runs.error)))
          .orderBy(desc(runs.startedAt)).limit(1).get()?.run;
        const baseChanges = completed?.context?.revision === revision && completed.mainSha && completed.mainSha !== mainSha
          ? await reviewChanges(repositoryPath, completed.mainSha, mainSha, completed.result?.paths ?? []) : undefined;
        queued += applyDecisions(item.id, planReview({ kind: "issue", completed, baseChanges, latest, attempt, revision, mainSha }));
      }
    } finally {
      if (item.kind === "pr") {
        try { await reconcilePrReview(github, item.id, item.payload.number, { itemId: item.id }); }
        catch (error) { log.warn({ event: "github.review_reconciliation_pending", itemId: item.id, err: error }); }
      }
    }
  }
  return queued;
}
