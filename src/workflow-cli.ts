import { desc, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { workflowOf, workflows } from "./actions.ts";
import { runCommand } from "./cli.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { describeError, SupersededError } from "./errors.ts";
import { getRun } from "./run-history.ts";
import { runNextTask } from "./runner.ts";
import { runs, tasks } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { validateStaticConfig, validateWorkflowDefinition } from "./startup.ts";
import { enqueueWorkflowRun } from "./tasks.ts";

const executeFile = promisify(execFile);
const appRoot = resolve(import.meta.dirname, "..");
const compiler = resolve(appRoot, "node_modules/typescript/bin/tsc");

function isProcessAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isServeRunning() {
  const pidFile = resolve("data/serve.pid");
  if (!existsSync(pidFile)) return false;
  return isProcessAlive(Number(readFileSync(pidFile, "utf8").trim()));
}

async function checkScript(scriptPath: string, local: boolean) {
  const packageFile = local ? findPackageJSON(pathToFileURL(scriptPath)) : undefined;
  const packageType = packageFile ? (JSON.parse(await readFile(packageFile, "utf8")) as { type?: unknown }).type : undefined;
  const standalone = local && packageType !== "module" && packageType !== "commonjs";
  try {
    await executeFile(process.execPath, [compiler,
      "--noEmit", "--target", "ES2023",
      "--module", standalone ? "Preserve" : "NodeNext",
      "--moduleResolution", standalone ? "Bundler" : "NodeNext",
      "--strict", "--allowImportingTsExtensions", "--resolveJsonModule",
      "--verbatimModuleSyntax", "--erasableSyntaxOnly", "--skipLibCheck", "--types", "node", "--pretty", "false",
      scriptPath,
    ], { cwd: appRoot, env: childEnvironment() });
  } catch (error) {
    const { stdout, stderr, message } = describeError(error);
    return [stdout, stderr].filter(Boolean).join("\n").trim() || message;
  }
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run workflow -- list",
    "  npm run workflow -- check [name]",
    "  npm run workflow -- run <name> [--input '<json>'] [--dry-run] [--now] [--priority N]",
  ].join("\n"));
}

function parseFlags(args: string[]) {
  let input: Record<string, unknown> | undefined;
  let dryRun = false;
  let now = false;
  let priority: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--now") { now = true; continue; }
    if (arg === "--priority" || arg.startsWith("--priority=")) {
      const raw = arg.startsWith("--priority=") ? arg.slice("--priority=".length) : args[++i];
      priority = Number(raw);
      if (!Number.isSafeInteger(priority)) throw new Error("Priority must be an integer");
      continue;
    }
    if (arg === "--input" || arg.startsWith("--input=")) {
      const raw = arg.startsWith("--input=") ? arg.slice("--input=".length) : args[++i];
      if (!raw) throw new Error("--input requires a JSON object");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (error) { throw new Error(`Invalid --input JSON: ${(error as Error).message}`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--input must be a JSON object");
      }
      input = parsed as Record<string, unknown>;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }
  return { positional, input, dryRun, now, priority };
}

await runCommand("Workflow command failed", async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (command === "list") {
    if (!workflows.length) {
      console.log("No workflows discovered.");
      return;
    }
    for (const def of workflows) {
      const wf = workflowOf(def.name);
      const triggers = [
        wf.on.cron ? `cron(${wf.on.cron})` : null,
        wf.on.event ? `event(${wf.on.event.source}:${wf.on.event.kind})` : null,
        wf.on.manual ? "manual" : null,
      ].filter(Boolean).join(",");
      const source = wf.local ? "local" : "bundled";
      const kind = wf.scriptPath ? "script" : "skill";
      console.log([
        wf.name,
        wf.enabled ? "enabled" : "disabled",
        `${source}:${kind}`,
        triggers || "-",
        `${wf.defaults.provider}/${wf.defaults.model}`,
        wf.description ?? "",
      ].join("\t"));
    }
    return;
  }

  if (command === "check") {
    const [target] = rest;
    const targets = target ? workflows.filter((wf) => wf.name === target) : workflows;
    if (target && !targets.length) {
      throw new Error(`Unknown workflow: ${target}; expected one of ${workflows.map((w) => w.name).join(", ") || "(none)"}`);
    }
    const problems: string[] = [];
    const compilerAvailable = existsSync(compiler);
    if (!compilerAvailable && targets.some((wf) => wf.scriptPath)) {
      console.error("WARN\tSkipping run.ts type checks: TypeScript compiler not installed (install dev dependencies)");
    }
    const checks = await Promise.all(targets.map(async (wf) => {
      const wfProblems = await validateWorkflowDefinition(wf, config, { checkDisabled: true });
      if (wf.scriptPath && compilerAvailable) {
        const diagnostic = await checkScript(wf.scriptPath, wf.local);
        if (diagnostic) wfProblems.push(`${wf.name}: run.ts type check failed:\n${diagnostic}`);
      }
      return wfProblems;
    }));
    for (const wfProblems of checks) problems.push(...wfProblems);
    if (problems.length) {
      for (const problem of problems) console.error(`FAIL\t${problem}`);
      process.exitCode = 1;
      return;
    }
    for (const wf of targets) {
      const resolved = workflowOf(wf.name);
      console.log(`OK\t${wf.name}\t${resolved.defaults.provider}/${resolved.defaults.model}\t${wf.hash.slice(0, 12)}`);
    }
    return;
  }

  if (command === "run") {
    const { positional, input, dryRun, now, priority } = parseFlags(rest);
    const [name] = positional;
    if (!name) usage();
    const def = workflows.find((wf) => wf.name === name);
    if (!def) throw new Error(`Unknown workflow: ${name}; expected one of ${workflows.map((w) => w.name).join(", ") || "(none)"}`);
    const problems = await validateWorkflowDefinition(def, config, { checkDisabled: true, checkSlack: !dryRun });
    if (problems.length) throw new Error(`Workflow ${name} failed validation:\n- ${problems.join("\n- ")}`);
    if (now) await validateStaticConfig();
    const task = enqueueWorkflowRun(name, { input, dryRun, priority });
    console.log([task.action, task.id, task.subjectId, dryRun ? "dry-run" : "live", "queued"].join("\t"));
    if (!now) return;
    const stop = new AbortController();
    const onSignal = (sig: NodeJS.Signals) => { stop.abort(new SupersededError(`Cancelled by user (${sig})`)); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      if (isServeRunning()) {
        console.log(`WAITING\t${task.id}\tDaemon is running; waiting for daemon to execute task`);
        while (!stop.signal.aborted) {
          const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
          if (!row) throw new Error(`Workflow task ${task.id} disappeared`);
          if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
            const latest = db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(desc(runs.sequence)).limit(1).get();
            if (row.status !== "completed" || latest?.error) {
              console.error(`FAILED\t${latest?.id ?? task.id}\t${latest?.error?.message ?? row.status}`);
              process.exitCode = 1;
              return;
            }
            console.log(`COMPLETED\t${latest?.id ?? task.id}\t${latest?.publication.status ?? "unknown"}`);
            if (latest?.result?.text) console.log(latest.result.text);
            return;
          }
          if (!isServeRunning()) {
            console.error(`DAEMON_STOPPED\t${task.id}\tDaemon exited while task was ${row.status}`);
            process.exitCode = 1;
            return;
          }
          await delay(500, undefined, { signal: stop.signal }).catch(() => {});
        }
        console.log(`DETACHED\t${task.id}\tStopped waiting; task remains managed by daemon`);
        return;
      }
      const cliPidDir = resolve("data/cli-tasks");
      const cliPidFile = resolve(cliPidDir, `${task.id}.pid`);
      mkdirSync(cliPidDir, { recursive: true });
      writeFileSync(cliPidFile, `${process.pid}\n`);
      let finished;
      try {
        finished = await runNextTask(stop.signal, task.id);
      } finally {
        rmSync(cliPidFile, { force: true });
      }
      if (!finished) {
        const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
        switch (row?.status) {
          case "queued":
            console.log(`QUEUED\t${task.id}\tWorker slots busy; task remains queued (do not re-run)`);
            return;
          case "running":
            console.log(`RUNNING\t${task.id}\tAlready claimed by another worker`);
            return;
          case "completed":
            console.log(`COMPLETED\t${task.id}`);
            return;
          default:
            throw new Error(`Workflow task ${task.id} is ${row?.status ?? "missing"}`);
        }
      }
      const latest = getRun(finished.id);
      if (finished.error) {
        const status = finished.error.name === "SupersededError" ? "CANCELLED" : "FAILED";
        console.error(`${status}\t${finished.id}\t${finished.error.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`COMPLETED\t${finished.id}\t${latest?.publication.status ?? "unknown"}`);
      if (latest?.result?.text) console.log(latest.result.text);
      return;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  usage();
});
