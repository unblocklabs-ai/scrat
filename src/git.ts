import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { childEnvironment } from "./secrets.ts";

const executeFile = promisify(execFile);
const repositoryFetches = new Map<string, Promise<string>>();

// Workspace Git commands can run repository hooks, so they get the child environment.
export async function git(repositoryPath: string, args: string[], env = childEnvironment()) {
  const { stdout } = await executeFile("git", ["-C", repositoryPath, ...args], { env, maxBuffer: 16 * 1024 * 1024 });
  // Path inventories and source blobs are byte-sensitive; only command metadata
  // (SHAs, refs, etc.) should have surrounding whitespace removed.
  return args.includes("-z") || args[0] === "show" ? stdout : stdout.trim();
}

const originPattern = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
const repositoryOfUrl = (url: string) => originPattern.exec(url.trim())?.[1]?.toLowerCase();

// `config --get` reports the stored URL, not an insteadOf rewrite of it.
async function assertOrigin(repositoryPath: string, remote: string) {
  const origin = await git(repositoryPath, ["config", "--get", "remote.origin.url"]).catch(() => "");
  const expected = repositoryOfUrl(remote);
  if (!expected || repositoryOfUrl(origin) !== expected) throw new Error(`Clone at ${repositoryPath} has origin ${origin || "(none)"}, not ${remote}`);
}

export async function fetchRepository(repositoryPath: string, remote: string, baseBranch: string, env = childEnvironment()) {
  repositoryPath = resolve(repositoryPath);
  const previous = repositoryFetches.get(repositoryPath);
  const pending = (async () => {
    if (previous) await previous.catch(() => {});
    if (!existsSync(repositoryPath)) {
      await mkdir(dirname(repositoryPath), { recursive: true });
      await executeFile("git", ["clone", "--single-branch", "--branch", baseBranch, "--", remote, repositoryPath], { env });
    }
    await assertOrigin(repositoryPath, remote);
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

export async function fetchPullRequestHead(repositoryPath: string, remote: string, number: number, env = childEnvironment()) {
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

export async function branchContainsCommit(repositoryPath: string, remote: string, branch: string, commitSha: string, env = childEnvironment()) {
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
