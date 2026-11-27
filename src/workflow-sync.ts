import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import { buildConfig, isObject } from "./config-merge.ts";
import { isProcessAlive, readOptionalText } from "./process-status.ts";
import { readWorkflowRepo } from "./workflows.ts";

const root = resolve("data/workflows-repo");
const checkouts = join(root, "checkouts");
const gitDir = join(root, "git");
const current = join(root, "current");
const marker = ".scrat-checkout-complete";
const appAuthHelp = "Set SCRAT_WORKFLOWS_TOKEN or use an SSH deploy key";

function localOverrides() {
  const body = readOptionalText(new URL("../scrat.local.json", import.meta.url));
  if (body === undefined) return {};
  const parsed: unknown = JSON.parse(body);
  if (!isObject(parsed)) throw new Error("Invalid scrat.local.json: expected a JSON object");
  return parsed;
}

function stat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function acquireLock(path: string) {
  const data = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n";
  const acquire = () => writeFileSync(path, data, { flag: "wx" });
  try { acquire(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const existing = stat(path);
  if (existing?.isFile()) {
    const body = readOptionalText(path);
    let owner: unknown;
    try { owner = body === undefined ? undefined : JSON.parse(body); }
    catch { }
    if (isObject(owner) && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !isProcessAlive(owner.pid)) {
      const currentLock = stat(path);
      if (currentLock?.ino === existing.ino && currentLock.dev === existing.dev) rmSync(path, { force: true });
    }
  }
  try { acquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another workflow sync holds ${path}; remove it only if that sync is no longer running`);
  }
}

function ensureDirectory(path: string) {
  if (!stat(path)) mkdirSync(path, { recursive: true });
  if (!stat(path)?.isDirectory()) throw new Error(`Not a real directory: ${path}`);
}

function rejectSymlinks(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Workflow checkout contains a symlink: ${path}`);
    if (entry.isDirectory()) rejectSymlinks(path);
  }
}

async function fetchAuth(url: string, github: unknown) {
  if (!/^https:\/\//i.test(url)) return {};
  const remote = new URL(url);
  if (remote.username || remote.password || remote.search || remote.hash) throw new Error("Workflow HTTPS URLs must not contain credentials, a query, or a fragment");
  let token = process.env.SCRAT_WORKFLOWS_TOKEN;
  let app = false;
  if (!token) {
    if (remote.origin !== "https://github.com") return {};
    if (isObject(github) && github.auth === "pat") {
      token = process.env.GITHUB_PAT;
      if (!token) return {};
    } else {
      try {
        const repo = /^\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.pathname)?.[1];
        const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
        if (!repo || !privateKey || !isObject(github) || typeof github.appId !== "number" || typeof github.installationId !== "number") throw new Error();
        const { createAppAuth } = await import("@octokit/auth-app");
        ({ token } = await createAppAuth({ appId: github.appId, privateKey })({
          type: "installation", installationId: github.installationId, repositoryNames: [repo], permissions: { contents: "read" },
        }));
        app = true;
      } catch {
        return { app: true };
      }
    }
  }
  const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { token, credential, app, env: {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credential}`,
  } };
}

async function sync() {
  if (process.argv.length !== 3) throw new Error("Usage: npm run workflow -- sync");
  const merged = buildConfig(settings, localOverrides());
  const repo = readWorkflowRepo(isObject(merged.workflows) ? merged.workflows.repo : undefined, merged.harness);
  if (!repo) {
    console.log("No workflows.repo configured.");
    return;
  }
  const { ref: sha, url, keepCheckouts, checkTimeoutSeconds } = repo;
  const checkout = join(checkouts, sha);
  const harness = isObject(merged.harness) ? merged.harness : settings.harness;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(key)
    || key.startsWith("LC_") || /^(https?|all|no)_proxy$/i.test(key)));
  const git = (args: string[], auth: Awaited<ReturnType<typeof fetchAuth>> = {}, extraEnv?: NodeJS.ProcessEnv) => {
    const command = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=true", "-c", "http.followRedirects=false", ...args], {
      encoding: "utf8",
      timeout: Number(harness.gitNetworkTimeoutSeconds) * 1000,
      maxBuffer: Number(harness.maxOutputBytes),
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh:file", ...auth.env, ...extraEnv },
    });
    if (command.status !== 0) {
      let detail = command.error?.message ?? (command.stderr.trim() || `exit ${command.status ?? command.signal}`);
      if (auth.token) detail = detail.replaceAll(auth.token, "[redacted]");
      if (auth.credential) detail = detail.replaceAll(auth.credential, "[redacted]");
      throw new Error(`${detail}${auth.app ? `\nGitHub App fetch failed. ${appAuthHelp}` : ""}`);
    }
    return command.stdout.trim();
  };

  ensureDirectory(root);
  const lock = join(root, "sync.lock");
  const work = join(root, "sync.work");
  acquireLock(lock);
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    ensureDirectory(checkouts);
    const pointer = stat(current);
    if (pointer && !pointer.isSymbolicLink()) throw new Error(`Not a workflow checkout symlink: ${current}`);
    let previous: string | undefined;
    if (pointer) {
      try { previous = realpathSync(current); }
      catch (error) { throw new Error(`Cannot resolve ${current}; move the broken symlink aside and retry`, { cause: error }); }
    }
    const cached = stat(checkout);
    if (cached && !cached.isDirectory()) throw new Error(`Not a real checkout directory: ${checkout}`);
    if (!cached || !stat(join(checkout, marker))?.isFile()) {
      if (previous === join(realpathSync(checkouts), sha)) throw new Error(`The current symlink already points to an incomplete checkout; move ${current} aside and retry`);
      const auth = await fetchAuth(url, merged.github);
      const gitStat = stat(gitDir);
      if (!gitStat) git(["init", "--bare", "--template=", gitDir]);
      else if (!gitStat.isDirectory()) throw new Error(`Not a real Git directory: ${gitDir}`);
      const gitArgs = [`--git-dir=${gitDir}`];
      git([...gitArgs, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", url, sha], auth);
      if (git([...gitArgs, "rev-parse", "FETCH_HEAD"]) !== sha) throw new Error(`Git did not fetch the requested workflow commit ${sha}`);
      if (git([...gitArgs, "cat-file", "-t", sha]) !== "commit") throw new Error(`Workflows pin ${sha} is not a Git commit`);

      const temporary = join(work, "checkout");
      mkdirSync(temporary);
      const treeArgs = [...gitArgs, `--work-tree=${temporary}`];
      const indexEnv = { GIT_INDEX_FILE: join(work, "index") };
      git([...treeArgs, "read-tree", sha], {}, indexEnv);
      git([...treeArgs, "checkout-index", "--all"], {}, indexEnv);
      rejectSymlinks(temporary);
      writeFileSync(join(temporary, marker), "", { flag: "wx" });
      if (cached) renameSync(checkout, join(work, "incomplete"));
      renameSync(temporary, checkout);
    } else {
      rejectSymlinks(checkout);
    }

    const validation = spawnSync(process.execPath, [
      ...(existsSync(".env") ? ["--env-file=.env"] : []), resolve(import.meta.dirname, "workflow-commands.ts"), "check",
    ], { env: { ...process.env, SCRAT_WORKFLOWS_CHECKOUT: checkout }, stdio: "inherit", timeout: checkTimeoutSeconds * 1000, killSignal: "SIGKILL" });
    if ((validation.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error(`Workflow checkout ${sha} validation timed out after ${checkTimeoutSeconds}s; current was not changed`);
    if (validation.status !== 0) throw new Error(`Workflow checkout ${sha} failed validation; current was not changed`, { cause: validation.error });

    if (previous === realpathSync(checkout)) {
      console.log(`Workflows already synced at ${sha}.`);
      return;
    }
    const next = join(work, "current");
    symlinkSync(join("checkouts", sha), next, "dir");
    renameSync(next, current);
    console.log(`Workflows synced: ${previous ? basename(previous) : "(none)"} -> ${sha}. Restart scrat.service to apply.`);

    try {
      const protectedPaths = new Set([realpathSync(checkout)]);
      if (previous) protectedPaths.add(previous);
      if (isProcessAlive(Number(readOptionalText("data/serve.pid")))) {
        const loaded = readOptionalText("data/serve.workflows-checkout")?.replace(/\n$/, "");
        if (loaded) protectedPaths.add(loaded);
      }
      const old = readdirSync(checkouts, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name))
        .map((entry) => join(checkouts, entry.name))
        .filter((dir) => !protectedPaths.has(realpathSync(dir)) && stat(join(dir, marker))?.isFile())
        .map((dir) => ({ dir, modified: stat(dir)!.mtimeMs }))
        .sort((a, b) => b.modified - a.modified || a.dir.localeCompare(b.dir));
      for (const { dir } of old.slice(Math.max(0, keepCheckouts - protectedPaths.size))) rmSync(dir, { recursive: true });
    } catch (error) {
      console.warn(`Workflow checkout pruning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); }
    finally { rmSync(lock, { force: true }); }
  }
}

try { await sync(); }
catch (error) {
  console.error(`Workflow sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
