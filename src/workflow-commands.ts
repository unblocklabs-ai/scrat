import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { workflowOf, workflows } from "./workflow-registry.ts";
import { config } from "./config.ts";
import { isObject } from "./config-merge.ts";
import { describeError, redactSecrets, SupersededError } from "./errors.ts";
import { isProcessAlive, readOptionalText } from "./process-status.ts";
import type { Run } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";

const executeFile = promisify(execFile);
const appRoot = resolve(import.meta.dirname, "..");
const compiler = resolve(appRoot, "node_modules/typescript/bin/tsc");

function isServeRunning() {
  return isProcessAlive(Number(readOptionalText("data/serve.pid")));
}

async function isStandaloneScript(scriptPath: string, local: boolean) {
  if (!local) return false;
  const packageFile = findPackageJSON(pathToFileURL(scriptPath));
  const packageType = packageFile ? (JSON.parse(new TextDecoder().decode(await readFile(packageFile))) as { type?: unknown }).type : undefined;
  return packageType !== "module" && packageType !== "commonjs";
}

async function checkScripts(scriptPaths: string[], standalone: boolean) {
  if (!scriptPaths.length) return undefined;
  try {
    await executeFile(process.execPath, [compiler,
      "--noEmit", "--target", "ES2023",
      "--module", standalone ? "Preserve" : "NodeNext",
      "--moduleResolution", standalone ? "Bundler" : "NodeNext",
      "--strict", "--allowImportingTsExtensions", "--resolveJsonModule",
      "--verbatimModuleSyntax", "--erasableSyntaxOnly", "--skipLibCheck", "--types", "node", "--pretty", "false",
      resolve(appRoot, "src/workflow-types.d.ts"), ...scriptPaths,
    ], { cwd: appRoot, env: childEnvironment() });
  } catch (error) {
    const { stdout, stderr, message } = describeError(error);
    return [stdout, stderr].filter(Boolean).join("\n").trim() || message;
  }
}

function isSqliteBusy(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /SQLITE_BUSY|database is locked/i.test(text);
}

async function readWithBusyRetry<T>(read: () => T, signal: AbortSignal): Promise<{ ok: true; value: T } | { ok: false }> {
  while (!signal.aborted) {
    try { return { ok: true, value: read() }; }
    catch (error) {
      if (!isSqliteBusy(error)) throw error;
      await delay(500, undefined, { signal }).catch(() => {});
    }
  }
  return { ok: false };
}

function reportRunOutcome(run: Run | undefined, fallbackId: string, status: "completed" | "failed" | "cancelled") {
  if (status !== "completed" || run?.error) {
    const label = status === "cancelled" || run?.error?.name === "SupersededError" ? "CANCELLED" : "FAILED";
    console.error(`${label}\t${run?.id ?? fallbackId}\t${run?.error?.message ?? status}`);
    process.exitCode = 1;
    return;
  }
  console.log(`COMPLETED\t${run?.id ?? fallbackId}\t${run?.publication.status ?? "unknown"}`);
  if (run?.result?.text) console.log(run.result.text);
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run workflow -- list",
    "  npm run workflow -- check [name]",
    "  npm run workflow -- run <name> [--input '<json>'] [--dry-run] [--now] [--priority N]",
    "  npm run workflow -- inspect <runId|taskId> [--step <name>] [--json]",
    "  npm run workflow -- replay <runId|taskId> [--from <step>] [--input '<json>'] [--plan] [--dry-run]",
    "  npm run workflow -- sync",
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

const [command, ...rest] = process.argv.slice(2);

async function main() {
  if (!command) usage();

  if (command === "inspect") {
    const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: {
      step: { type: "string" }, json: { type: "boolean" },
    } });
    const [id] = positionals;
    if (!id || positionals.length !== 1) usage();
    const { inspectWorkflow } = await import("./workflow-replay.ts");
    inspectWorkflow(id, values.step, values.json);
    return;
  }

  if (command === "replay") {
    const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: {
      from: { type: "string" }, input: { type: "string" }, plan: { type: "boolean" }, "dry-run": { type: "boolean" },
    } });
    const [id] = positionals;
    if (!id || positionals.length !== 1) usage();
    const input: unknown = values.input === undefined ? undefined : JSON.parse(values.input);
    if (input !== undefined && !isObject(input)) throw new Error("--input must be a JSON object");
    const { printReplayPlan, replayWorkflow } = await import("./workflow-replay.ts");
    if (values.plan) {
      printReplayPlan(id, values.from);
      return;
    }
    const { runCommand } = await import("./cli.ts");
    await runCommand("Workflow replay failed", async () => {
      const replay = await replayWorkflow(id, values.from, input);
      reportRunOutcome(replay.run, replay.run.id, replay.status);
      if (replay.status === "completed") console.log(`PREVIEW\t${replay.preview}`);
    });
    return;
  }

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
        wf.origin,
      ].join("\t"));
    }
    return;
  }

  if (command === "check") {
    const { validateWorkflowDefinition } = await import("./startup.ts");
    const [target] = rest;
    const targets = target ? workflows.filter((wf) => wf.name === target) : workflows;
    if (target && !targets.length) {
      throw new Error(`Unknown workflow: ${target}; expected one of ${workflows.map((w) => w.name).join(", ") || "(none)"}`);
    }
    const problems: string[] = [];
    const compilerAvailable = existsSync(compiler);
    if (!compilerAvailable && targets.some((wf) => wf.scriptPath)) {
      const diagnostic = "TypeScript compiler not installed (install dev dependencies)";
      if (process.env.SCRAT_WORKFLOWS_CHECKOUT !== undefined) problems.push(`Cannot check run.ts scripts: ${diagnostic}`);
      else console.error(`WARN\tSkipping run.ts type checks: ${diagnostic}`);
    }
    const standardScripts: { name: string; scriptPath: string }[] = [];
    const standaloneScripts: { name: string; scriptPath: string }[] = [];
    for (const wf of targets) {
      problems.push(...await validateWorkflowDefinition(wf, config, { checkDisabled: true }));
      if (wf.scriptPath && compilerAvailable) {
        if (await isStandaloneScript(wf.scriptPath, wf.local)) standaloneScripts.push({ name: wf.name, scriptPath: wf.scriptPath });
        else standardScripts.push({ name: wf.name, scriptPath: wf.scriptPath });
      }
    }
    for (const [group, standalone] of [[standardScripts, false], [standaloneScripts, true]] as const) {
      if (!group.length) continue;
      const batchError = await checkScripts(group.map((entry) => entry.scriptPath), standalone);
      if (!batchError) continue;
      if (group.length === 1) {
        problems.push(`${group[0]!.name}: run.ts type check failed:\n${batchError}`);
        continue;
      }
      for (const entry of group) {
        const diagnostic = await checkScripts([entry.scriptPath], standalone);
        if (diagnostic) problems.push(`${entry.name}: run.ts type check failed:\n${diagnostic}`);
      }
    }
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
    const { getRun, getTask, latestRunOfTask } = await import("./run-history.ts");
    const { runNextTask } = await import("./runner.ts");
    const { validateStaticConfig, validateWorkflowDefinition } = await import("./startup.ts");
    const { enqueueWorkflowRun } = await import("./tasks.ts");
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
          const fetched = await readWithBusyRetry(() => {
            const row = getTask(task.id);
            const terminal = row && (row.status === "completed" || row.status === "failed" || row.status === "cancelled");
            return { row, latest: terminal ? latestRunOfTask(task.id) : undefined };
          }, stop.signal);
          if (!fetched.ok) break;
          const { row, latest } = fetched.value;
          if (!row) throw new Error(`Workflow task ${task.id} disappeared`);
          if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
            reportRunOutcome(latest, task.id, row.status);
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
        const row = getTask(task.id);
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
      reportRunOutcome(getRun(finished.id) ?? finished, finished.id, finished.error ? "failed" : "completed");
      return;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  usage();
}

if (command === "run" || command === "check") {
  const { runCommand } = await import("./cli.ts");
  await runCommand("Workflow command failed", main);
} else {
  try { await main(); }
  catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
