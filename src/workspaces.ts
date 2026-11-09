import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { changedPaths, commitOf, git, headOf, hasPendingMerge, identity, isAncestor, mergeHeadOf } from "./git.ts";
import { botSlug } from "./identity.ts";
import { withOperation } from "./logging.ts";
import { runs, subjects, workspaces, type Run, type Workspace } from "./schema.ts";
import { errorMessage, ifMissing, WorkflowPushRejected } from "./errors.ts";
import { SecretLeakError } from "./results.ts";
import { containsSecret } from "./secrets.ts";
import { sandboxHome, workspaceRoot } from "./sandbox.ts";

export function getWorkspace(workspaceId: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
}

const pinRef = (workspaceId: string) => `refs/scrat/workspaces/${workspaceId}`;

export async function pinWorkspaceBase(workspace: Workspace, sha: string) {
  await git(workspace.repositoryPath, ["update-ref", pinRef(workspace.id), sha]);
}

export async function validateWorkspace(workspace: Workspace) {
  if (!(await lstat(workspace.path)).isDirectory()) throw new Error("Workspace path is not its original directory");
  const path = await realpath(workspace.path);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await git(path, ["symbolic-ref", "--short", "HEAD"]);
  if (!(await lstat(resolve(path, ".git"))).isDirectory() || path !== top || await realpath(common) !== resolve(path, ".git") || branch !== workspace.branch) throw new Error("Workspace Git identity changed");
}

export async function workspaceMatchesCommit({ path }: Workspace, commitSha: string) {
  return await headOf(path) === commitSha && !await hasPendingMerge(path)
    && !await git(path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
}

export async function stageTree(path: string) {
  await git(path, ["add", "--all"]);
  return git(path, ["write-tree"]);
}

export async function checkpointWorkspace(workspace: Workspace) {
  const treeSha = await stageTree(workspace.path);
  return {
    headSha: await headOf(workspace.path),
    treeSha,
    mergeHead: await mergeHeadOf(workspace.path),
  };
}

export async function checkpointMatches(workspace: Workspace, checkpoint: NonNullable<Run["agentCheckpoint"]>) {
  const headSha = await headOf(workspace.path);
  const mergeHead = await mergeHeadOf(workspace.path);
  const changed = await git(workspace.path, ["diff", "--name-only", "-z", checkpoint.treeSha, "--"]);
  const untracked = await git(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return headSha === checkpoint.headSha && mergeHead === checkpoint.mergeHead && !changed && !untracked;
}

export async function assertNoCommittedSecrets(workspace: Workspace, base: string, tree: string) {
  const changed = await changedPaths(workspace.path, base, tree);
  for (const path of changed) {
    const file = resolve(workspace.path, path);
    const stats = await ifMissing(lstat(file), undefined);
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
  let path = resolve(workspaceRoot(), workspaceId);
  return withOperation("workspace.create", {
    ...references, workspaceId, repositoryPath, path, branch, baseRef,
  }, async (operation) => {
    operation.stage("resolve_base");
    repositoryPath = await git(resolve(repositoryPath), ["rev-parse", "--show-toplevel"]);
    const baseSha = await git(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
    operation.stage("create_workspace");
    await mkdir(dirname(path), { recursive: true });
    path = resolve(await realpath(dirname(path)), workspaceId);
    await git(repositoryPath, ["clone", "--no-checkout", "--shared", "--", repositoryPath, path]);
    await git(path, ["checkout", "-B", branch, baseSha]);
    await writeFile(resolve(path, ".git/info/exclude"), "/.scrat/\n");
    await git(repositoryPath, ["update-ref", pinRef(workspaceId), baseSha]);
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

export function replacedWorkspaces(taskId?: string) {
  return db.select({ id: workspaces.id }).from(workspaces)
    .where(and(isNull(workspaces.removedAt), isNotNull(workspaces.replacement),
      taskId ? sql`json_extract(${workspaces.replacement}, '$.taskId') = ${taskId}` : undefined)).all();
}

function replacementWasPublished(replacement: Workspace["replacement"]) {
  // Another base move can replace the replacement before anything is published.
  while (replacement) {
    const receipt = db.select({ id: runs.id }).from(runs).where(and(
      eq(runs.workspaceId, replacement.workspaceId), eq(runs.taskId, replacement.taskId),
      sql`json_extract(${runs.publication}, '$.status') = 'published'
        and json_extract(${runs.publication}, '$.publishedCommitSha') = json_extract(${runs.publication}, '$.commitSha')`,
    )).get();
    if (receipt) return true;
    replacement = getWorkspace(replacement.workspaceId)?.replacement ?? null;
  }
  return false;
}

function workspaceInUse(workspaceId: string) {
  return db.select({ id: subjects.id }).from(subjects).where(eq(subjects.workspaceId, workspaceId)).get()
    || db.select({ id: runs.id }).from(runs).where(and(eq(runs.workspaceId, workspaceId), isNull(runs.finishedAt))).get();
}

async function hasUnarchivedRefs({ path, repositoryPath, branch }: Workspace, commitSha: string) {
  const refList = ["for-each-ref", "--format=%(objectname) %(refname)"];
  const extra = (await git(path, refList)).split("\n").filter((line) => line && line !== `${commitSha} refs/heads/${branch}`);
  // A stash ref can have a whole stack of unpublished entries in its reflog.
  if (extra.some((line) => line.endsWith(" refs/stash"))) return true;
  if (!extra.length) return false;
  const shared = (await git(repositoryPath, refList)).split("\n");
  const sharedRefs = new Set(shared), sharedTips = new Set(shared.map((line) => line.split(" ", 1)[0]));
  for (const line of extra) {
    if (sharedRefs.has(line)) continue;
    const [tip, ref] = line.split(" ") as [string, string];
    const tracking = ref.startsWith("refs/remotes/");
    if (tracking && sharedTips.has(tip)) continue;
    if ((tracking || ref.startsWith("refs/heads/")) && await isAncestor(path, tip, commitSha)) continue;
    return true;
  }
  return false;
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
    const { repositoryPath, branch, replacement } = workspace;
    if (replacement && (!replacementWasPublished(replacement) || workspaceInUse(workspaceId))) {
      operation.complete({ retained: "Replacement publication not confirmed or checkout still in use" });
      return workspace;
    }
    const path = await ifMissing(realpath(workspace.path), workspace.path);
    operation.stage("remove_workspace");
    const present = await ifMissing(lstat(path).then(() => true), false);
    if (present) {
      if (path !== resolve(workspaceRoot(), workspace.id)) throw new Error("Refusing cleanup outside the owned workspace root");
      await validateWorkspace(workspace);
      if (replacement) {
        if (!await workspaceMatchesCommit(workspace, replacement.originalHead)) throw new Error("Replaced checkout has changed; retain it for recovery");
        if (await hasUnarchivedRefs(workspace, replacement.originalHead)) throw new Error("Replaced checkout has local refs not preserved by recovery; retain it");
      } else {
        const head = await headOf(path);
        const published = db.select().from(runs).where(eq(runs.workspaceId, workspace.id)).all()
          .some((run) => run.publication.publishedCommitSha === head);
        if (head !== workspace.baseSha && !published) throw new Error("Workspace has unpublished commits; retain it for recovery");
      }
    }
    if (replacement) {
      const recoveryRef = `refs/scrat/recovery/${workspaceId}`;
      const archived = await commitOf(repositoryPath, recoveryRef);
      if (archived !== replacement.originalHead) {
        if (archived) throw new Error("Recovery ref does not match the replaced checkout");
        // Refresh pinned this exact commit in the source repository before adopting the replacement.
        await git(repositoryPath, ["update-ref", recoveryRef, replacement.originalHead, ""]);
      }
      if (workspaceInUse(workspaceId)) {
        operation.complete({ retained: "Replaced checkout is still in use" });
        return workspace;
      }
    }
    if (present) {
      await rm(path, { recursive: true });
    }
    if (present || replacement) {
      const home = sandboxHome(workspace.id);
      const stats = await ifMissing(lstat(home), undefined);
      if (stats?.isDirectory() && !stats.isSymbolicLink()) await rm(home, { recursive: true });
    }
    operation.stage("unpin");
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
  const merging = await hasPendingMerge(workspace.path);
  if (staged || merging) {
    await git(workspace.path, [...identity(author), "commit", ...merging ? ["--no-edit", "--cleanup=strip"] : ["-m", message]]);
    const commitSha = await headOf(workspace.path);
    recordEvent({ ...references, type: "workspace.committed", data: { workspaceId: workspace.id, commitSha } });
    return commitSha;
  }
  return headOf(workspace.path);
}

export async function importWorkspaceCommit(workspace: Workspace, commitSha: string) {
  if (await commitOf(workspace.repositoryPath, commitSha)) return;
  const bundle = resolve(workspace.path, ".scrat/publish.bundle");
  const directory = dirname(bundle);
  const existing = await ifMissing(lstat(directory), undefined);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Publication directory is not an owned directory");
  if (!existing) await mkdir(directory);
  const tip = `refs/heads/${workspace.branch}`;
  const prerequisite = await commitOf(workspace.repositoryPath, pinRef(workspace.id)) ?? workspace.baseSha;
  try {
    await git(workspace.path, ["bundle", "create", bundle, `${prerequisite}..${tip}`]);
    await git(workspace.repositoryPath, ["bundle", "verify", bundle]);
  } catch {
    await rm(bundle, { force: true });
    await git(workspace.path, ["bundle", "create", bundle, tip]);
  }
  if (!(await lstat(bundle)).isFile() || await realpath(bundle) !== bundle) throw new Error("Publication bundle is not an owned regular file");
  await git(workspace.repositoryPath, ["fetch", "--no-tags", "--", bundle, tip]);
}

export async function pushWorkspace(workspace: Workspace, remote: string, commitSha: string, env: NodeJS.ProcessEnv, references: EventReferences = {}) {
  await importWorkspaceCommit(workspace, commitSha);
  await pinWorkspaceBase(workspace, commitSha);
  try { await git(workspace.repositoryPath, ["push", "--", remote, `${commitSha}:refs/heads/${workspace.branch}`], env); }
  catch (error) {
    if (/refusing to allow .* to create or update workflow .* without [`']workflows?[`'] (?:permission|scope)/i.test(errorMessage(error))) throw new WorkflowPushRejected(error);
    throw error;
  }
  recordEvent({ ...references, type: "workspace.pushed", data: { workspaceId: workspace.id, commitSha } });
  return commitSha;
}
