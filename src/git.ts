import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repositoryFetches = new Map<string, Promise<string>>();

export async function git(repositoryPath: string, args: string[], env = process.env) {
  const { stdout } = await executeFile("git", ["-C", repositoryPath, ...args], { env, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function fetchRepository(repositoryPath: string, remote: string, baseBranch: string, env = process.env) {
  repositoryPath = resolve(repositoryPath);
  const previous = repositoryFetches.get(repositoryPath);
  const pending = (async () => {
    if (previous) await previous.catch(() => {});
    if (!existsSync(repositoryPath)) {
      await mkdir(dirname(repositoryPath), { recursive: true });
      await executeFile("git", ["clone", "--single-branch", "--branch", baseBranch, "--", remote, repositoryPath], { env });
    }
    await git(repositoryPath, ["fetch", "--", remote, `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], env);
    return git(repositoryPath, ["rev-parse", `refs/remotes/origin/${baseBranch}`]);
  })();
  repositoryFetches.set(repositoryPath, pending);
  try {
    return await pending;
  } finally {
    if (repositoryFetches.get(repositoryPath) === pending) repositoryFetches.delete(repositoryPath);
  }
}

export async function fetchPullRequestHead(repositoryPath: string, remote: string, number: number, env = process.env) {
  const ref = `refs/remotes/origin/pr/${number}`;
  await git(repositoryPath, ["fetch", "--", remote, `+refs/pull/${number}/head:${ref}`], env);
  return ref;
}

export async function hasPendingMerge(repositoryPath: string) {
  const mergeHead = await git(repositoryPath, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  return existsSync(resolve(repositoryPath, mergeHead));
}

export async function hasConflicts(repositoryPath: string, base: string, head: string) {
  try {
    await git(repositoryPath, ["merge-tree", "--write-tree", base, head]);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return true;
    throw error;
  }
}

export async function branchContainsCommit(repositoryPath: string, remote: string, branch: string, commitSha: string, env = process.env) {
  const advertised = await git(repositoryPath, ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`], env);
  const remoteSha = advertised.split(/\s+/)[0];
  if (!remoteSha) return false;
  if (remoteSha === commitSha) return true;
  await git(repositoryPath, ["fetch", "--no-write-fetch-head", "--", remote, remoteSha], env);
  try {
    await git(repositoryPath, ["merge-base", "--is-ancestor", commitSha, remoteSha]);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return false;
    throw error;
  }
}
