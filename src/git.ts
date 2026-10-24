import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { childEnvironment } from "./secrets.ts";
import { serialized } from "./single-flight.ts";
import { inWorkspace, sandboxCommand } from "./sandbox.ts";

const executeFile = promisify(execFile);
const networkOptions = () => ({ timeout: config.harness.gitNetworkTimeoutSeconds * 1000, killSignal: "SIGKILL" }) as const;
const repositoryFetches = new Map<string, Promise<unknown>>();

const networkCommands = new Set(["fetch", "ls-remote", "push"]);

function timedOut(label: string) {
  return (error: unknown) => {
    if (error instanceof Error && "killed" in error && error.killed) error.message = `Git ${label} timed out after ${config.harness.gitNetworkTimeoutSeconds} seconds`;
    throw error;
  };
}

const gitCommand = (repositoryPath: string, args: string[], env: NodeJS.ProcessEnv) => inWorkspace(repositoryPath)
  ? sandboxCommand(repositoryPath, "git", args, env) : { file: "git", args: ["-C", repositoryPath, ...args], env };

export async function git(repositoryPath: string, args: string[], env = childEnvironment()) {
  const command = gitCommand(repositoryPath, args, env);
  const { stdout } = await executeFile(command.file, command.args, { cwd: repositoryPath, env: command.env, maxBuffer: config.harness.maxOutputBytes, ...(networkCommands.has(args[0]!) ? networkOptions() : {}) }).catch(timedOut(args[0]!));
  return args.includes("-z") || args[0] === "show" ? stdout : stdout.trim();
}

export const headOf = (repositoryPath: string) => git(repositoryPath, ["rev-parse", "HEAD"]);

export async function gitList(repositoryPath: string, args: string[]) {
  return (await git(repositoryPath, args)).split("\0").filter(Boolean);
}

export const changedPaths = (repositoryPath: string, ...range: string[]) => gitList(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", ...range]);

export type GitPage = { text: string; end: number; more: boolean; total?: number };

export async function blobSize(repositoryPath: string, object: string) {
  try {
    return await git(repositoryPath, ["cat-file", "-t", object]) === "blob" ? Number(await git(repositoryPath, ["cat-file", "-s", object])) || undefined : undefined;
  } catch { return undefined; }
}

export function gitPage(repositoryPath: string, args: string[], offset: number, limit: number) {
  return new Promise<GitPage>((done, fail) => {
    const command = gitCommand(repositoryPath, args, childEnvironment());
    const child = spawn(command.file, command.args, { cwd: repositoryPath, env: command.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let position = 0, kept = 0, stderr = "", stopped = false;
    child.stderr.on("data", (data: Buffer) => { if (stderr.length < 8192) stderr += data.toString(); });
    child.stdout.on("data", (data: Buffer) => {
      if (stopped) return;
      const start = Math.max(0, offset - position), take = data.subarray(start, start + limit + 1 - kept);
      position += data.length;
      if (take.length) { chunks.push(take); kept += take.length; }
      if (kept > limit) { stopped = true; child.kill(); }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (!stopped && code !== 0) {
        return fail(Object.assign(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`), { code, stderr }));
      }
      const bytes = Buffer.concat(chunks), more = bytes.length > limit;
      let size = more ? limit : bytes.length;
      if (more) while (size > 1 && (bytes[size]! & 0xc0) === 0x80) size--;
      done({ text: bytes.subarray(0, size).toString(), end: offset + size, more, ...(stopped ? {} : { total: position }) });
    });
  });
}

const originPattern = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
const repositoryOfUrl = (url: string) => originPattern.exec(url.trim())?.[1]?.toLowerCase();

async function assertOrigin(repositoryPath: string, remote: string) {
  const origin = await git(repositoryPath, ["config", "--get", "remote.origin.url"]).catch(() => "");
  const expected = repositoryOfUrl(remote);
  if (!expected || repositoryOfUrl(origin) !== expected) throw new Error(`Clone at ${repositoryPath} has origin ${origin || "(none)"}, not ${remote}`);
}

async function excludeWorkingNotes(repositoryPath: string) {
  const exclude = resolve(repositoryPath, await git(repositoryPath, ["rev-parse", "--git-common-dir"]), "info", "exclude");
  const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (current.split("\n").includes("/.scrat/")) return;
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.scrat/\n`);
}

export async function fetchRepository(repositoryPath: string, remote: string, baseBranch: string, env = childEnvironment()) {
  repositoryPath = resolve(repositoryPath);
  return serialized(repositoryFetches, repositoryPath, async () => {
    if (!existsSync(repositoryPath)) {
      await mkdir(dirname(repositoryPath), { recursive: true });
      await executeFile("git", ["clone", "--single-branch", "--branch", baseBranch, "--", remote, repositoryPath], { env, ...networkOptions() }).catch(timedOut("clone"));
    }
    await assertOrigin(repositoryPath, remote);
    await git(repositoryPath, ["config", "gc.auto", "0"]);
    await excludeWorkingNotes(repositoryPath);
    await git(repositoryPath, ["fetch", "--", remote, `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], env);
    return git(repositoryPath, ["rev-parse", `refs/remotes/origin/${baseBranch}`]);
  });
}

export async function fetchPullRequestHead(repositoryPath: string, remote: string, number: number, expectedSha: string, env = childEnvironment()) {
  const ref = `refs/remotes/origin/pr/${number}`;
  const resolved = () => git(repositoryPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  return serialized(repositoryFetches, resolve(repositoryPath), async () => {
    if (await resolved() === expectedSha) return expectedSha;
    await git(repositoryPath, ["fetch", "--", remote, `+refs/pull/${number}/head:${ref}`], env);
    if (await resolved() !== expectedSha) await git(repositoryPath, ["fetch", "--", remote, `+${expectedSha}:${ref}`], env).catch(() => undefined);
    const actual = await resolved();
    if (actual !== expectedSha) throw new Error(`PR #${number} head ${expectedSha} could not be fetched; ${ref} resolves to ${actual || "nothing"}`);
    return expectedSha;
  });
}

export async function prepareTarget(cwd: string, mainSha: string, headSha: string) {
  const behind = !await isAncestor(cwd, mainSha, headSha);
  return { mainSha, headSha, behind, conflicts: behind && await hasConflicts(cwd, mainSha, headSha) };
}

export async function hasPendingMerge(repositoryPath: string) {
  const mergeHead = await git(repositoryPath, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  return existsSync(resolve(repositoryPath, mergeHead));
}

export async function mergeHeadOf(repositoryPath: string) {
  return await hasPendingMerge(repositoryPath) ? git(repositoryPath, ["rev-parse", "MERGE_HEAD"]) : null;
}

async function exitsOne(command: Promise<unknown>) {
  try {
    await command;
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return true;
    throw error;
  }
}

const hasConflicts = (repositoryPath: string, base: string, head: string) => exitsOne(git(repositoryPath, ["merge-tree", "--write-tree", base, head]));

export async function branchContainsCommit(workspace: { path: string; repositoryPath: string }, remote: string, branch: string, commitSha: string, env = childEnvironment()) {
  const { repositoryPath } = workspace;
  const advertised = await git(repositoryPath, ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`], env);
  const remoteSha = advertised.split(/\s+/)[0];
  if (!remoteSha) return false;
  if (remoteSha === commitSha) return true;
  await git(repositoryPath, ["fetch", "--no-write-fetch-head", "--", remote, remoteSha], env);
  let where = workspace.path;
  try {
    await git(where, ["cat-file", "-e", `${commitSha}^{commit}`]);
    await git(where, ["cat-file", "-e", `${remoteSha}^{commit}`]).catch(async () => {
      where = repositoryPath;
      await git(where, ["cat-file", "-e", `${commitSha}^{commit}`]);
    });
  } catch {
    return false;
  }
  return isAncestor(where, commitSha, remoteSha);
}

export async function isAncestor(repositoryPath: string, ancestor: string, descendant: string) {
  return !await exitsOne(git(repositoryPath, ["merge-base", "--is-ancestor", ancestor, descendant]));
}

type Author = { name: string; email: string };
export const identity = (author: Author) => ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];

export async function mergeBase(workspacePath: string, base: string, message: string, author: Author) {
  await git(workspacePath, [...identity(author), "merge", "--no-ff", "-m", message, base]);
}

export async function createMergeCommit(repositoryPath: string, base: string, head: string, message: string, author: Author) {
  const tree = (await git(repositoryPath, ["merge-tree", "--write-tree", base, head])).split("\n")[0]!;
  return git(repositoryPath, [...identity(author), "commit-tree", tree, "-p", head, "-p", base, "-m", message]);
}
