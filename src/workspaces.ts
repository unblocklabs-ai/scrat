import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { git, hasPendingMerge } from "./git.ts";
import { botSlug } from "./identity.ts";
import { withOperation } from "./logging.ts";
import { runs, workspaces, type Run, type Workspace } from "./schema.ts";
import { errorCode } from "./errors.ts";
import { SecretLeakError } from "./results.ts";
import { containsSecret } from "./secrets.ts";
import { config } from "./config.ts";

export function getWorkspace(workspaceId: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
}

const pinRef = (workspaceId: string) => `refs/scrat/workspaces/${workspaceId}`;

export async function pinWorkspaceBase(workspace: Workspace, sha: string) {
  await git(workspace.repositoryPath, ["update-ref", pinRef(workspace.id), sha]);
}

export async function backfillWorkspaceLayouts() {
  for (const workspace of db.select().from(workspaces).where(and(isNull(workspaces.layout), isNull(workspaces.removedAt))).all()) {
    const stats = await lstat(resolve(workspace.path, ".git")).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; });
    if (stats) db.update(workspaces).set({ layout: stats.isDirectory() ? "clone" : "worktree" }).where(eq(workspaces.id, workspace.id)).run();
  }
}

export async function validateWorkspace(workspace: Workspace) {
  if (!(await lstat(workspace.path)).isDirectory()) throw new Error("Workspace path is not its original directory");
  const path = await realpath(workspace.path);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await git(path, ["symbolic-ref", "--short", "HEAD"]);
  if ((await lstat(resolve(path, ".git"))).isDirectory() !== (workspace.layout === "clone")) throw new Error("Workspace Git identity changed");
  if (workspace.layout === "clone") {
    if (path !== top || await realpath(common) !== resolve(path, ".git") || branch !== workspace.branch) throw new Error("Workspace Git identity changed");
    return;
  }
  const expected = await git(workspace.repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const registered = await git(workspace.repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
  if (path !== top || await realpath(common) !== await realpath(expected) || branch !== workspace.branch
    || !registered.split("\0").includes(`worktree ${path}`)) throw new Error("Workspace Git identity changed");
}

export async function isolateWorkspace(workspace: Workspace) {
  if (config.workspace?.layout !== "clone" || workspace.layout === "clone") return;
  await validateWorkspace(workspace);
  const head = await git(workspace.path, ["rev-parse", "HEAD"]);
  const oldGit = await git(workspace.path, ["rev-parse", "--absolute-git-dir"]);
  await mkdir("data/private-git", { recursive: true });
  const recovery = await mkdtemp(resolve("data/private-git", `${workspace.id}.`));
  const staging = resolve(recovery, "clone");
  await git(workspace.repositoryPath, ["clone", "--no-checkout", "--shared", "--", workspace.repositoryPath, staging]);
  await git(staging, ["update-ref", `refs/heads/${workspace.branch}`, head]);
  await writeFile(resolve(staging, ".git/HEAD"), `ref: refs/heads/${workspace.branch}\n`);
  for (const entry of ["index", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "logs"]) {
    await cp(resolve(oldGit, entry), resolve(staging, ".git", entry), { recursive: true }).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; });
  }
  await writeFile(resolve(staging, ".git/info/exclude"), "/.scrat/\n");
  await rename(resolve(workspace.path, ".git"), resolve(recovery, "linked-git-pointer"));
  try { await rename(resolve(staging, ".git"), resolve(workspace.path, ".git")); }
  catch (error) { await rename(resolve(recovery, "linked-git-pointer"), resolve(workspace.path, ".git")); throw error; }
  const converted = db.update(workspaces).set({ layout: "clone" }).where(eq(workspaces.id, workspace.id)).returning().get() ?? { ...workspace, layout: "clone" as const };
  await validateWorkspace(converted);
}

export async function checkpointWorkspace(workspace: Workspace) {
  await git(workspace.path, ["add", "--all"]);
  return {
    headSha: await git(workspace.path, ["rev-parse", "HEAD"]),
    treeSha: await git(workspace.path, ["write-tree"]),
    mergeHead: await hasPendingMerge(workspace.path) ? await git(workspace.path, ["rev-parse", "MERGE_HEAD"]) : null,
  };
}

export async function validateCheckpoint(workspace: Workspace, checkpoint: NonNullable<Run["agentCheckpoint"]>) {
  const headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
  const mergeHead = await hasPendingMerge(workspace.path) ? await git(workspace.path, ["rev-parse", "MERGE_HEAD"]) : null;
  const changed = await git(workspace.path, ["diff", "--name-only", "-z", checkpoint.treeSha, "--"]);
  const untracked = await git(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (headSha !== checkpoint.headSha || mergeHead !== checkpoint.mergeHead || changed || untracked) {
    throw new Error("Validation checkpoint source changed; use normal retry to repair the current workspace");
  }
}

export async function assertNoCommittedSecrets(workspace: Workspace, base: string, tree: string) {
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
  branch ??= `${botSlug}/${workspaceId}`;
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
    if (config.workspace?.layout === "clone") {
      await git(repositoryPath, ["clone", "--no-checkout", "--shared", "--", repositoryPath, path]);
      await git(path, ["checkout", "-B", branch, baseSha]);
      await writeFile(resolve(path, ".git/info/exclude"), "/.scrat/\n");
    } else await git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, baseSha]);
    await git(repositoryPath, ["update-ref", pinRef(workspaceId), baseSha]);
    operation.stage("persistence");
    const workspace = db.transaction((transaction) => {
      const created = transaction.insert(workspaces).values({
        id: workspaceId, repositoryPath, path, branch, baseRef, baseSha, layout: config.workspace?.layout === "clone" ? "clone" : "worktree",
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
    const privateClone = workspace.layout === "clone";
    const present = await lstat(path).then(() => true, (error: unknown) => { if (errorCode(error) === "ENOENT") return false; throw error; });
    if (privateClone ? present : registered.split("\0").includes(`worktree ${path}`)) {
      await validateWorkspace(workspace);
      const head = await git(path, ["rev-parse", "HEAD"]);
      const published = db.select().from(runs).where(eq(runs.workspaceId, workspace.id)).all()
        .some((run) => run.publication.publishedCommitSha === head);
      if (head !== workspace.baseSha && !published) throw new Error("Workspace has unpublished commits; retain it for recovery");
      if (privateClone) {
        if (path !== resolve(await realpath("data/workspaces"), workspace.id)) throw new Error("Refusing cleanup outside the owned workspace root");
        await rm(path, { recursive: true });
        const home = resolve("data/sandbox-homes", workspace.id);
        const stats = await lstat(home).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; });
        if (stats?.isDirectory() && !stats.isSymbolicLink()) await rm(home, { recursive: true });
      } else await git(repositoryPath, ["worktree", "remove", "--", path]);
    }
    operation.stage("delete_branch");
    const existingBranch = await git(repositoryPath, ["branch", "--list", "--format=%(refname)", branch]);
    if (existingBranch && !privateClone) await git(repositoryPath, ["branch", "-D", "--", branch]);
    await git(repositoryPath, ["update-ref", "-d", pinRef(workspaceId)]);
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

export async function commitWorkspace(workspace: Workspace, message: string, author: { name: string; email: string }, references: EventReferences = {}) {
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

export async function pushWorkspace(workspace: Workspace, remote: string, commitSha: string, env: NodeJS.ProcessEnv, references: EventReferences = {}) {
  if (workspace.layout === "clone") {
    const bundle = resolve(workspace.path, ".scrat/publish.bundle");
    const directory = dirname(bundle);
    const existing = await lstat(directory).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Publication directory is not an owned directory");
    if (!existing) await mkdir(directory);
    const tip = `refs/heads/${workspace.branch}`;
    const prerequisite = await git(workspace.repositoryPath, ["rev-parse", "--verify", "--quiet", `${pinRef(workspace.id)}^{commit}`]).catch(() => workspace.baseSha);
    try {
      await git(workspace.path, ["bundle", "create", bundle, `${prerequisite}..${tip}`]);
      await git(workspace.repositoryPath, ["bundle", "verify", bundle]);
    } catch {
      await rm(bundle, { force: true });
      await git(workspace.path, ["bundle", "create", bundle, tip]);
    }
    if (!(await lstat(bundle)).isFile() || await realpath(bundle) !== bundle) throw new Error("Publication bundle is not an owned regular file");
    await git(workspace.repositoryPath, ["fetch", "--no-tags", "--", bundle, `refs/heads/${workspace.branch}`]);
    await pinWorkspaceBase(workspace, commitSha);
  }
  await git(workspace.repositoryPath, ["push", "--", remote, `${commitSha}:refs/heads/${workspace.branch}`], env);
  recordEvent({ ...references, type: "workspace.pushed", data: { workspaceId: workspace.id, commitSha } });
  return commitSha;
}
