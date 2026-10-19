import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts } from "./git.ts";
import { fetchItemContext, getGitEnvironment, githubRevision } from "./github.ts";
import { items, runs, tasks } from "./schema.ts";
import { cancelQueuedTasks, enqueueTask } from "./tasks.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";

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

function queue(item: Item, action: Action, priority: number, reason: string, input: Record<string, unknown> & { triggerKey: string }) {
  const latest = latestTask(item.id, action);
  if (latest?.status !== "cancelled" && latest?.input.triggerKey === input.triggerKey) return 0;
  enqueueTask({ itemId: item.id, action, priority, reason, input });
  return 1;
}

export async function routeGithubTasks(repository: string, current: Item[], previous: Map<string, Item>, log: Logger) {
  const repositoryPath = getRepositoryPath();
  const remote = `https://github.com/${repository}.git`;
  const env = await getGitEnvironment(repository);
  const defaultBaseSha = await fetchRepository(repositoryPath, remote, config.github.baseBranch, env);
  let queued = 0;
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
          await removeWorkspace(workspace.id, { itemId: item.id });
        }
      }
      continue;
    }
    if (previous.get(item.externalId)?.state === "closed" && item.workspaceId && getWorkspace(item.workspaceId)?.removedAt) {
      db.update(items).set({ workspaceId: null }).where(eq(items.id, item.id)).run();
      item.workspaceId = null;
    }
    if (item.kind === "issue" && hasScratLabel(item)) {
      cancelQueuedTasks(item.id, "Issue selected for implementation", "review_issue");
      const latest = latestTask(item.id, "implement");
      const wasLabelled = previous.get(item.externalId);
      if (!item.workspaceId && (!latest || latest.status === "queued" || latest.status === "cancelled" || (wasLabelled && !hasScratLabel(wasLabelled)))) {
        queued += queue(item, "implement", 60, "Issue has the scrat label", {
          triggerKey: JSON.stringify({ labelledAt: item.payload.updated_at, mainSha }), mainSha,
        });
      }
      continue;
    }
    if (item.kind === "issue") cancelQueuedTasks(item.id, "Scrat label removed", "implement");
    const context = await fetchItemContext(repository, item.kind, item.payload.number, log);
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
      if (await hasConflicts(repositoryPath, mainSha, headSha)) {
        queued += queue(item, "resolve_conflicts", 100, "Scrat PR conflicts with its base branch", {
          triggerKey: JSON.stringify({ mainSha, headSha }), mainSha, headSha,
        });
      } else cancelQueuedTasks(item.id, "PR no longer conflicts", "resolve_conflicts");
      const handled = db.select().from(tasks).where(and(eq(tasks.itemId, item.id), eq(tasks.action, "address_pr_feedback"))).all()
        .filter((task) => task.status === "completed" || task.status === "running");
      const consumed = new Set(handled.flatMap((task) => strings(task.input.commentRevisions)));
      const pending = comments.filter((comment) => !consumed.has(`${comment.id}@${comment.updatedAt}`));
      if (pending.length) {
        const commentRevisions = pending.map((comment) => `${comment.id}@${comment.updatedAt}`).sort();
        queued += queue(item, "address_pr_feedback", 80, "New feedback on a Scrat PR", {
          triggerKey: JSON.stringify(commentRevisions), comments: pending, commentRevisions,
        });
      } else cancelQueuedTasks(item.id, "Feedback already handled", "address_pr_feedback");
      continue;
    }
    const action = item.kind === "issue" ? "review_issue" : "review_pr";
    const revision = githubRevision(context.item, comments);
    const latest = latestTask(item.id, action);
    const triggerKey = JSON.stringify({ revision, mainSha });
    if (latest?.status !== "cancelled" && latest?.input.triggerKey === triggerKey) continue;
    const completed = db.select({ run: runs, task: tasks }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
      .where(and(eq(tasks.itemId, item.id), eq(tasks.action, action), eq(tasks.status, "completed"), isNull(runs.error)))
      .orderBy(desc(runs.startedAt)).limit(1).get();
    let changedPaths: string[] = [];
    if (completed?.task.input.revision === revision && completed.run.mainSha) {
      if (completed.run.mainSha === mainSha) {
        cancelQueuedTasks(item.id, "No changes since the last review", action);
        continue;
      }
      changedPaths = (await git(repositoryPath, ["diff", "--name-only", "--no-renames", completed.run.mainSha, mainSha])).split("\n").filter(Boolean);
      const paths = strings(completed.run.result?.paths);
      const relevant = !paths.length || changedPaths.some((changed) => paths.some((path) => path === "." || changed === path || changed.startsWith(path + "/")));
      if (!changedPaths.length || !relevant) {
        cancelQueuedTasks(item.id, "Base changes do not affect the reviewed scope", action);
        continue;
      }
    }
    queued += queue(item, action, 10, completed ? "Relevant GitHub or base-branch changes" : "Initial GitHub review", {
      triggerKey, revision, mainSha, changedPaths, comments,
      previousMainSha: completed?.run.mainSha ?? null,
      previousHeadSha: completed?.run.headSha ?? null,
    });
  }
  return queued;
}
