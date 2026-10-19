import { eq } from "drizzle-orm";
import { actionContracts } from "./actions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { branchContainsCommit } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { reconcileLabels } from "./labels.ts";
import { reconcilePrReview } from "./pr-review-state.ts";
import { upsertItem } from "./items.ts";
import { items, runs, tasks } from "./schema.ts";
import { getWorkspace, pushWorkspace } from "./workspaces.ts";

export async function publishRun(github: GitHubRepository, task: typeof tasks.$inferSelect, run: typeof runs.$inferSelect, current: GithubContext, references: EventReferences) {
  const { result, context } = run;
  if (!result || !context) throw new Error("Run has no evaluated result to publish");
  if (result.outcome !== "complete") throw new Error("Incomplete agent work cannot be published");
  const { repository } = github;
  const remote = `https://github.com/${repository}.git`;
  const marker = `<!-- scrat-task:${task.id} -->`;
  let publication = run.publication;
  function saveReceipt(patch: Partial<typeof publication>, database: Pick<typeof db, "update"> = db) {
    publication = { ...publication, ...patch };
    database.update(runs).set({ publication }).where(eq(runs.id, run.id)).run();
  }
  const contract = actionContracts[task.action];
  if (contract.mode === "change") {
    const workspace = run.workspaceId ? getWorkspace(run.workspaceId) : undefined;
    if (!workspace || workspace.removedAt) throw new Error("Publication workspace is no longer active");
    const commitSha = publication.commitSha;
    if (!commitSha) throw new Error("Run has no validated commit to publish");
    if (publication.publishedCommitSha !== commitSha) {
      const env = await github.getGitEnvironment(true);
      if (!await branchContainsCommit(workspace.repositoryPath, remote, workspace.branch, commitSha, env)) {
        await pushWorkspace(workspace, remote, commitSha, env, references);
      }
      saveReceipt({ publishedCommitSha: commitSha });
    }
    if (contract.publication === "pull-request") {
      if (!publication.pullRequestNumber) {
        let pr = await github.findPullRequest(workspace.branch, context.baseBranch);
        if (pr?.state === "closed") throw new Error("The workspace PR was already closed");
        pr ??= await github.createPullRequest({
          title: `fix: ${context.item.title}`, body: `${result.text}\n\nCloses #${context.item.number}\n\n${marker}`,
          head: workspace.branch, base: context.baseBranch,
        }, references);
        const publishedPr = pr;
        db.transaction((transaction) => {
          const created = upsertItem({ source: "github", externalId: publishedPr.node_id, kind: "pr", payload: publishedPr }, transaction);
          transaction.update(items).set({ workspaceId: workspace.id }).where(eq(items.id, created.id)).run();
          saveReceipt({ pullRequestNumber: publishedPr.number }, transaction);
        });
      }
      saveReceipt({ status: "published" });
      return;
    }
  }
  if (contract.publication === "pr-assessment") {
    await reconcilePrReview(github, task.itemId, context.item.number, references, { task, run });
    return;
  }
  const body = `${result.text}\n\n${marker}`;
  const existing = current.comments.findLast((comment) => comment.id.startsWith("issue:") && comment.author === config.github.botLogin
    && comment.body.trimEnd().endsWith(marker));
  if (!publication.commentId) {
    let commentId: number;
    if (existing) {
      commentId = Number(existing.id.slice("issue:".length));
      if (existing.body !== body) await github.updateComment(commentId, body, references);
    } else {
      commentId = (await github.postComment(context.item.number, body, references)).data.id;
    }
    saveReceipt({ commentId });
  }
  if (contract.publication === "issue-assessment") {
    await reconcileLabels(github, context.item.number, {
      current: current.item.labels ?? [], desired: result.ready ? ["scrat"] : [], managed: ["scrat"],
    }, references);
    saveReceipt({ scratLabel: result.ready });
  }
  saveReceipt({ status: "published" });
}
