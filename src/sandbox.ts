import { existsSync, lstatSync, mkdirSync, statSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config, getRepositoryPath } from "./config.ts";

const packageStoreMount = "/home/scrat/.local/share/pnpm/store";

export function inWorkspace(path: string) {
  const root = workspaceRoot();
  const local = relative(root, existsSync(path) ? realpathSync(path) : resolve(path));
  return local !== "" && local !== ".." && !local.startsWith("../") && !isAbsolute(local);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && config.workspace?.sandbox) {
  mkdirSync("data/workspaces", { recursive: true });
  const cwd = await mkdtemp(join(workspaceRoot(), "sandbox-preflight-"));
  try {
    const command = sandboxCommand(cwd, "/bin/sh", ["-c", `node --version && pnpm --version && git --version${config.workspace?.packageStore ? ` && touch ${packageStoreMount}/.preflight && rm ${packageStoreMount}/.preflight` : ""}`], {});
    const { stdout } = await promisify(execFile)(command.file, command.args, { env: command.env, timeout: 30_000 });
    process.stdout.write(`Sandbox ready\n${stdout}`);
  } finally {
    await rm(cwd, { recursive: true });
    const home = join(realpathSync("data/sandbox-homes"), relative(workspaceRoot(), cwd));
    if (existsSync(home) && realpathSync(home) === home) await rm(home, { recursive: true });
  }
}

function workspaceRoot() {
  const path = resolve("data/workspaces");
  return existsSync(path) ? realpathSync(path) : path;
}

export function sandboxCommand(cwd: string, file: string, args: string[], environment: NodeJS.ProcessEnv, readOnly: string[] = [], track = false) {
  if (!config.workspace?.sandbox) return { file, args, env: environment };
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) throw new Error("workspace.sandbox requires Linux bubblewrap; refusing unsandboxed execution");
  if (!inWorkspace(cwd)) throw new Error("Sandbox commands must run inside an owned workspace");
  const workspace = realpathSync(cwd);
  mkdirSync("data/sandbox-homes", { recursive: true, mode: 0o700 });
  const home = join(realpathSync("data/sandbox-homes"), relative(workspaceRoot(), workspace).split("/")[0]);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (realpathSync(home) !== home) throw new Error("Sandbox home is not its owned directory");
  const limit = config.workspace?.commandMemoryMax;
  const mounts = ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run"];
  const bind = (source: string, destination = source, writable = false) => {
    mounts.push(writable ? "--bind" : "--ro-bind", source, destination);
  };
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) if (existsSync(path)) bind(path);
  for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ssl/certs", "/etc/alternatives"]) if (existsSync(path)) bind(path);
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  if (!nodeRoot.startsWith("/usr/") && nodeRoot !== "/usr") bind(nodeRoot);
  const corepack = resolve(process.env.COREPACK_HOME ?? join(process.env.HOME ?? "/nonexistent", ".cache/node/corepack"));
  if (existsSync(join(corepack, "lastKnownGood.json"))) {
    const version = (JSON.parse(readFileSync(join(corepack, "lastKnownGood.json"), "utf8")) as { pnpm?: unknown }).pnpm;
    if (typeof version === "string" && /^\d+\.\d+\.\d+(?:\+[^/]+)?$/.test(version)) {
      const pnpm = join(corepack, "v1/pnpm", version.split("+")[0]);
      if (existsSync(join(pnpm, "bin/pnpm.mjs"))) {
        bind(pnpm, "/opt/scrat-pnpm");
        mounts.push("--symlink", "/opt/scrat-pnpm/bin/pnpm.mjs", "/opt/scrat-bin/pnpm");
      }
    }
  }
  const repository = join(getRepositoryPath(), ".git");
  if (existsSync(repository)) bind(repository);
  for (const path of readOnly) bind(realpathSync(path));
  bind(workspace, workspace, true);
  bind(home, "/home/scrat", true);
  const store = config.workspace?.packageStore;
  if (store) {
    mkdirSync(store, { recursive: true, mode: 0o700 });
    if (lstatSync(store).isSymbolicLink() || !statSync(store).isDirectory()) throw new Error("workspace.packageStore must be a real directory");
    bind(realpathSync(store), packageStoreMount, true);
  }
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !name.startsWith("XDG_") && !name.startsWith("GIT_CONFIG") && !["HOME", "PATH", "DOCKER_HOST", "TMPDIR", "TMP", "TEMP"].includes(name)));
  Object.assign(env, store ? { npm_config_store_dir: packageStoreMount } : {}, { HOME: "/home/scrat", PATH: `${dirname(process.execPath)}:/opt/scrat-bin:/usr/local/bin:/usr/bin:/bin:/sbin`, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  const bwrap = [...mounts, "--chdir", workspace, "--", file === "git" ? "/usr/bin/git" : file, ...args];
  if (!limit) return { file: "/usr/bin/bwrap", args: bwrap, env, unit: undefined };
  const unit = `scrat-${relative(workspaceRoot(), workspace).split("/")[0].replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}-${randomBytes(6).toString("hex")}.scope`;
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[name]) env[name] = process.env[name];
  const unset = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((name) => ["--unsetenv", name]);
  return {
    file: "/usr/bin/systemd-run",
    args: ["--user", "--scope", "--quiet", ...(track ? [] : ["--collect"]), `--unit=${unit}`, "-p", `MemoryMax=${limit}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=stop", "--", "/usr/bin/bwrap", ...unset, ...bwrap],
    env, unit,
  };
}

export async function reportMemoryKill(unit: string | undefined, error: unknown) {
  if (!unit) return error;
  const run = promisify(execFile);
  const { stdout } = await run("/usr/bin/systemctl", ["--user", "show", unit, "-p", "Result", "--value"], { env: process.env }).catch(() => ({ stdout: "" }));
  await run("/usr/bin/systemctl", ["--user", "reset-failed", unit], { env: process.env }).catch(() => undefined);
  if (stdout.trim() !== "oom-kill") return error;
  return Object.assign(new Error(`Command exceeded workspace.commandMemoryMax (${config.workspace?.commandMemoryMax}) and was killed for running out of memory`, { cause: error }), { code: "COMMAND_OUT_OF_MEMORY" });
}
