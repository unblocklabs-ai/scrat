import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { git, hasPendingMerge } from "./git.ts";
import { withOperation } from "./logging.ts";
import { runs, workspaces } from "./schema.ts";
import { errorCode } from "./errors.ts";
import { SecretLeakError } from "./results.ts";
import { containsSecret } from "./secrets.ts";

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

export async function checkpointWorkspace(workspace: typeof workspaces.$inferSelect) {
  await git(workspace.path, ["add", "--all"]);
  return {
    headSha: await git(workspace.path, ["rev-parse", "HEAD"]),
    treeSha: await git(workspace.path, ["write-tree"]),
    mergeHead: await hasPendingMerge(workspace.path) ? await git(workspace.path, ["rev-parse", "MERGE_HEAD"]) : null,
  };
}

export async function validateCheckpoint(workspace: typeof workspaces.$inferSelect, checkpoint: NonNullable<typeof runs.$inferSelect.agentCheckpoint>) {
  const headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
  const mergeHead = await hasPendingMerge(workspace.path) ? await git(workspace.path, ["rev-parse", "MERGE_HEAD"]) : null;
  const changed = await git(workspace.path, ["diff", "--name-only", "-z", checkpoint.treeSha, "--"]);
  const untracked = await git(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (headSha !== checkpoint.headSha || mergeHead !== checkpoint.mergeHead || changed || untracked) {
    throw new Error("Validation checkpoint source changed; use normal retry to repair the current workspace");
  }
}

// Pushed history is the most durable place for a credential to leak.
export async function assertNoCommittedSecrets(workspace: typeof workspaces.$inferSelect, base: string, tree: string) {
  const changed = (await git(workspace.path, ["diff", "--name-only", "--no-renames", "-z", base, tree])).split("\0").filter(Boolean);
  for (const path of changed) {
    const file = resolve(workspace.path, path);
    const stats = await lstat(file).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    const content = stats?.isSymbolicLink() ? await readlink(file) : stats?.isFile() ? (await readFile(file)).toString("latin1") : "";
    if (containsSecret(content)) {
      throw new SecretLeakError(`Refusing to commit credential material in ${path}`);
    }
  }
}

export async function createWorkspace(
  { repositoryPath, baseRef, branch }: { repositoryPath: string; baseRef: string; branch?: string },
  references: EventReferences = {},
) {
  const workspaceId = randomUUID();
  branch ??= `scrat/${workspaceId}`;
  let path = resolve("data/workspaces", workspaceId);
  return withOperation("workspace.create", {
    ...references, workspaceId, repositoryPath, path, branch, baseRef,
  }, async (operation) => {
    operation.stage("resolve_base");
    repositoryPath = await git(resolve(repositoryPath), ["rev-parse", "--show-toplevel"]);
    const baseSha = await git(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
    operation.stage("create_worktree");
    await mkdir(dirname(path), { recursive: true });
    path = resolve(await realpath(dirname(path)), workspaceId);
    await git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, baseSha]);
    operation.stage("persistence");
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
  });
}

export async function removeWorkspace(workspaceId: string, references: EventReferences = {}) {
  return withOperation("workspace.remove", { ...references, workspaceId }, async (operation) => {
    operation.stage("lookup");
    const workspace = getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.removedAt) {
      operation.complete({ alreadyRemoved: true });
      return workspace;
    }
    const { repositoryPath, branch } = workspace;
    const path = await realpath(workspace.path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return workspace.path;
      throw error;
    });
    operation.stage("remove_worktree");
    const registered = await git(repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
    if (registered.split("\0").includes(`worktree ${path}`)) {
      await validateWorkspace(workspace);
      const head = await git(path, ["rev-parse", "HEAD"]);
      const published = db.select().from(runs).where(eq(runs.workspaceId, workspace.id)).all()
        .some((run) => run.publication.publishedCommitSha === head);
      if (head !== workspace.baseSha && !published) throw new Error("Workspace has unpublished commits; retain it for recovery");
      await git(repositoryPath, ["worktree", "remove", "--", path]);
    }
    operation.stage("delete_branch");
    const existingBranch = await git(repositoryPath, ["branch", "--list", "--format=%(refname)", branch]);
    if (existingBranch) await git(repositoryPath, ["branch", "-D", "--", branch]);
    operation.stage("persistence");
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
  });
}

export async function commitWorkspace(workspace: typeof workspaces.$inferSelect, message: string, author: { name: string; email: string }, references: EventReferences = {}) {
  await git(workspace.path, ["add", "--all"]);
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
