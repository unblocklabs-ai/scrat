import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { errorExitCode } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { branchContainsCommit, git, identity, isAncestor, remoteBranchHead, workflowPaths } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import { bestEffort } from "./logging.ts";
import { remoteUrl } from "./repository.ts";
import { validateRefreshedChange } from "./run-change.ts";
import { botAuthor, type Ctx, stopBefore } from "./run-context.ts";
import { getRun, updateRun } from "./run-history.ts";
import { type Run, subjects, workspaces } from "./schema.ts";
import { createWorkspace, getWorkspace, importWorkspaceCommit, pinWorkspaceBase, removeWorkspace, validateWorkspace, workspaceMatchesCommit } from "./workspaces.ts";

export async function refreshChangePublication(ctx: Ctx, github: GitHubRepository, run: Run) {
  const { mainSha, context, publication, verification } = run;
  const { commitSha } = publication;
  if (!ctx.manifest.publish.includes("push") || publication.commentOnly || publication.publishedCommitSha || publication.pullRequestNumber
    || !mainSha || !context || !commitSha || verification?.headSha !== commitSha) return;

  const workspace = run.workspaceId ? getWorkspace(run.workspaceId) : undefined;
  if (!workspace || workspace.removedAt) return;
  const { repositoryPath, branch, path } = workspace;
  const base = await github.fetchBranch(context.baseBranch);
  const common = await git(path, ["merge-base", base, commitSha]);
  if (!(await workflowPaths(path, common, base)).length) return;

  const remote = remoteUrl(github.repository), env = await github.getGitEnvironment();
  const expected = context.headSha ?? publication.previousPushSha;
  const remoteHead = () => remoteBranchHead(repositoryPath, remote, branch, env);
  if (await remoteHead() !== expected) {
    // A push can succeed before its receipt is saved. Reconcile it; do not replace it.
    if (await branchContainsCommit(workspace, remote, branch, commitSha, env)) return;
    throw new Error("Remote branch changed before publication recovery; original work was retained");
  }
  await validateWorkspace(workspace);
  if (!await workspaceMatchesCommit(workspace, commitSha)) {
    throw new Error("Workspace changed before publication recovery; original work was retained");
  }
  if (!await isAncestor(path, mainSha, base) || (expected && !await isAncestor(path, expected, commitSha))) {
    throw new Error("Base or branch history changed before publication recovery; original work was retained");
  }

  stopBefore(ctx.stop, "publication recovery");
  await importWorkspaceCommit(workspace, commitSha);
  await pinWorkspaceBase(workspace, commitSha);
  let tree: string;
  try { tree = (await git(repositoryPath, ["merge-tree", "--write-tree", base, commitSha])).split("\n")[0]!; }
  catch (error) {
    if (errorExitCode(error) !== 1) throw error;
    throw new Error("The saved change conflicts with the current base; original work was retained", { cause: error });
  }
  if (ctx.manifest.acceptance === "nonempty_diff" && tree === await git(repositoryPath, ["rev-parse", `${base}^{tree}`])) {
    throw new Error("The saved change no longer differs from the current base; original work was retained");
  }
  const message = await git(repositoryPath, ["show", "-s", "--format=%B", commitSha]);
  // A new branch needs only the new base. An existing PR must retain its published head as a parent.
  const parents = expected && expected !== base ? ["-p", expected, "-p", base] : ["-p", base];
  const refreshed = await git(repositoryPath, [...identity(botAuthor()), "commit-tree", tree, ...parents, "-m", message.trimEnd()]);
  const candidate = await createWorkspace({ repositoryPath, baseRef: refreshed, branch }, ctx.references);
  let adopted = false;
  try {
    const checks = await validateRefreshedChange(ctx, candidate, base, refreshed);
    if (await remoteHead() !== expected) throw new Error("Remote branch changed during publication recovery; original work was retained");
    const latestBase = await github.fetchBranch(context.baseBranch);
    if (!(await isAncestor(repositoryPath, base, latestBase)) || (await workflowPaths(repositoryPath, base, latestBase)).length) {
      throw new Error("Base workflows changed again during publication recovery; retry publication against the new base");
    }
    const updated = db.transaction((transaction) => {
      transaction.update(workspaces).set({ replacement: { workspaceId: candidate.id, taskId: run.taskId, originalHead: commitSha } })
        .where(eq(workspaces.id, workspace.id)).run();
      transaction.update(subjects).set({ workspaceId: candidate.id }).where(eq(subjects.workspaceId, workspace.id)).run();
      updateRun(run.id, { workspaceId: candidate.id, mainSha: base, headSha: refreshed, verification: checks,
        publication: { ...publication, commitSha: refreshed } }, transaction);
      recordEvent({ ...ctx.references, type: "workspace.publication_refreshed", data: {
        originalWorkspaceId: workspace.id, workspaceId: candidate.id, originalCommitSha: commitSha, commitSha: refreshed, base,
      } }, transaction);
      return getRun(run.id, transaction)!;
    });
    adopted = true;
    return updated;
  } finally {
    if (!adopted) await bestEffort(ctx.operation.log, "run.cleanup_pending", { workspaceId: candidate.id }, () => removeWorkspace(candidate.id, ctx.references));
  }
}
