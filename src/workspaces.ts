import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { git, hasPendingMerge } from "./git.ts";
import { startOperation } from "./logging.ts";
import { runs, workspaces } from "./schema.ts";

export function getWorkspace(workspaceId: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
}

export async function validateWorkspace(workspace: typeof workspaces.$inferSelect) {
  if (!(await lstat(workspace.path)).isDirectory()) throw new Error("Workspace path is not its original directory");
  const path = await realpath(workspace.path);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const expected = await git(workspace.repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await git(path, ["symbolic-ref", "--short", "HEAD"]);
  const registered = await git(workspace.repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
  if (path !== top || await realpath(common) !== await realpath(expected) || branch !== workspace.branch
    || !registered.split("\0").includes(`worktree ${path}`)) throw new Error("Workspace Git identity changed");
}

export async function createWorkspace(
  { repositoryPath, baseRef = "origin/main", branch }: { repositoryPath: string; baseRef?: string; branch?: string },
  references: EventReferences = {},
) {
  const workspaceId = randomUUID();
  branch ??= `scrat/${workspaceId}`;
  let path = resolve("data/workspaces", workspaceId);
  const operation = startOperation("workspace.create", {
    ...references, workspaceId, repositoryPath, path, branch, baseRef,
  });
  let stage = "resolve_base";
  try {
    repositoryPath = await git(resolve(repositoryPath), ["rev-parse", "--show-toplevel"]);
    const baseSha = await git(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
    stage = "create_worktree";
    await mkdir(dirname(path), { recursive: true });
    path = resolve(await realpath(dirname(path)), workspaceId);
    await git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, baseSha]);
    stage = "persistence";
    const workspace = db.transaction((transaction) => {
      const created = transaction.insert(workspaces).values({
        id: workspaceId, repositoryPath, path, branch, baseRef, baseSha,
      }).returning().get()!;
      recordEvent({
        ...references,
        operationId: operation.operationId,
        type: "workspace.created",
        data: { workspaceId, repositoryPath, path, branch },
      }, transaction);
      return created;
    });
    operation.complete({ baseSha, path });
    return workspace;
  } catch (error) {
    operation.fail(error, { stage });
    throw error;
  }
}

export async function removeWorkspace(workspaceId: string, references: EventReferences = {}) {
  const operation = startOperation("workspace.remove", { ...references, workspaceId });
  let stage = "lookup";
  try {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.removedAt) {
      operation.complete({ alreadyRemoved: true });
      return workspace;
    }
    const { repositoryPath, branch } = workspace;
    const path = await realpath(workspace.path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return workspace.path;
      throw error;
    });
    stage = "remove_worktree";
    const registered = await git(repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
    if (registered.split("\0").includes(`worktree ${path}`)) {
      await validateWorkspace(workspace);
      const head = await git(path, ["rev-parse", "HEAD"]);
      const published = db.select().from(runs).where(eq(runs.workspaceId, workspace.id)).all()
        .some((run) => run.publication.publishedCommitSha === head);
      if (head !== workspace.baseSha && !published) throw new Error("Workspace has unpublished commits; retain it for recovery");
      await git(repositoryPath, ["worktree", "remove", "--", path]);
    }
    stage = "delete_branch";
    const existingBranch = await git(repositoryPath, ["branch", "--list", "--format=%(refname)", branch]);
    if (existingBranch) await git(repositoryPath, ["branch", "-D", "--", branch]);
    stage = "persistence";
    const removed = db.transaction((transaction) => {
      const updated = transaction.update(workspaces).set({ path, removedAt: new Date().toISOString() })
        .where(eq(workspaces.id, workspaceId)).returning().get()!;
      recordEvent({
        ...references,
        operationId: operation.operationId,
        type: "workspace.removed",
        data: { workspaceId, repositoryPath, path, branch },
      }, transaction);
      return updated;
    });
    operation.complete();
    return removed;
  } catch (error) {
    operation.fail(error, { stage });
    throw error;
  }
}

export async function commitWorkspace(workspace: typeof workspaces.$inferSelect, message: string, author: { name: string; email: string }, references: EventReferences = {}) {
  await git(workspace.path, ["add", "--all"]);
  await git(workspace.path, ["diff", "--cached", "--check"]);
  const staged = await git(workspace.path, ["diff", "--cached", "--name-only"]);
  if (staged || await hasPendingMerge(workspace.path)) {
    await git(workspace.path, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
    const commitSha = await git(workspace.path, ["rev-parse", "HEAD"]);
    recordEvent({ ...references, type: "workspace.committed", data: { workspaceId: workspace.id, commitSha } });
    return commitSha;
  }
  return git(workspace.path, ["rev-parse", "HEAD"]);
}

export async function pushWorkspace(workspace: typeof workspaces.$inferSelect, remote: string, commitSha: string, env: NodeJS.ProcessEnv, references: EventReferences = {}) {
  await git(workspace.repositoryPath, ["push", "--", remote, `${commitSha}:refs/heads/${workspace.branch}`], env);
  recordEvent({ ...references, type: "workspace.pushed", data: { workspaceId: workspace.id, commitSha } });
  return commitSha;
}
