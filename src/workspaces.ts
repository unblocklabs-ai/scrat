import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { startOperation } from "./logging.ts";
import { workspaces } from "./schema.ts";

const executeFile = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]) {
  const { stdout } = await executeFile("git", ["-C", repositoryPath, ...args]);
  return stdout.trim();
}

export function getWorkspace(workspaceId: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
}

export async function createWorkspace(
  { repositoryPath, baseRef = "origin/main" }: { repositoryPath: string; baseRef?: string },
  references: EventReferences = {},
) {
  const workspaceId = randomUUID();
  const branch = `scrat/${workspaceId}`;
  const path = resolve("data/workspaces", workspaceId);
  const operation = startOperation("workspace.create", {
    ...references, workspaceId, repositoryPath, path, branch, baseRef,
  });
  let stage = "resolve_base";
  try {
    repositoryPath = await git(resolve(repositoryPath), "rev-parse", "--show-toplevel");
    const baseSha = await git(repositoryPath, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`);
    stage = "create_worktree";
    await mkdir(dirname(path), { recursive: true });
    await git(repositoryPath, "worktree", "add", "-b", branch, "--", path, baseSha);
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
    operation.complete({ baseSha });
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
    const { repositoryPath, path, branch } = workspace;
    stage = "remove_worktree";
    const registered = await git(repositoryPath, "worktree", "list", "--porcelain", "-z");
    if (registered.split("\0").includes(`worktree ${path}`)) {
      await git(repositoryPath, "worktree", "remove", "--", path);
    }
    stage = "delete_branch";
    const existingBranch = await git(repositoryPath, "branch", "--list", "--format=%(refname)", branch);
    if (existingBranch) await git(repositoryPath, "branch", "-D", "--", branch);
    stage = "persistence";
    const removed = db.transaction((transaction) => {
      const updated = transaction.update(workspaces).set({ removedAt: new Date().toISOString() })
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
