import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { EventReferences } from "./events.ts";
import { config } from "./config.ts";
import { redactSecrets } from "./errors.ts";
import { logger, withOperation } from "./logging.ts";
import { reportMemoryKill, sandboxCommand } from "./sandbox.ts";
import type { Check } from "./schema.ts";

export async function runCommands(commands: string[][], cwd: string, environment: NodeJS.ProcessEnv, references: EventReferences & { runId: string }, stage: string) {
  const checks: Check[] = [];
  const directory = resolve("data/checks", references.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [index, [file, ...args]] of commands.entries()) {
    await withOperation("workspace.command", { ...references, command: [file, ...args], cwd }, async (operation) => {
      const started = performance.now();
      const name = [file, ...args].join(" ");
      const evidence = resolve(directory, `${stage}-${index}-${Date.now()}.log`);
      const command = sandboxCommand(cwd, file, args, environment, [], true);
      const log = createWriteStream(evidence, { mode: 0o600 });
      let writeError: Error | undefined;
      log.on("error", (error) => { writeError ??= error; });
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; killed: boolean; tail: Buffer }>((done, fail) => {
        const child = spawn(command.file, command.args, { cwd, env: command.env, stdio: ["ignore", "pipe", "pipe"], timeout: config.harness.commandTimeoutSeconds * 1000, killSignal: "SIGKILL" });
        let tail = Buffer.alloc(0);
        const keep = (chunk: Buffer) => {
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > config.harness.commandOutputTailBytes) tail = tail.subarray(-config.harness.commandOutputTailBytes);
        };
        for (const stream of [child.stdout, child.stderr]) { stream.on("data", keep); stream.pipe(log, { end: false }); }
        child.on("error", fail);
        child.on("close", (code, signal) => done({ code, signal, killed: child.killed, tail }));
      }).catch(async (error) => { throw await reportMemoryKill(command.unit, error); }).finally(() => { log.end(); return finished(log).catch(() => undefined); });
      const tail = redactSecrets(outcome.tail.toString("utf8"));
      const check: Check = { name, status: outcome.code === 0 ? "passed" : "failed", durationMs: Math.round(performance.now() - started), tail, evidence: [evidence] };
      if (check.status === "failed") {
        const message = outcome.killed ? `Command timed out after ${config.harness.commandTimeoutSeconds} seconds: ${name}` : `Command failed: ${name}`;
        throw await reportMemoryKill(command.unit, Object.assign(new Error(message, { cause: writeError }), { code: outcome.code, signal: outcome.signal, killed: outcome.killed, stdout: tail }));
      }
      if (writeError) throw await reportMemoryKill(command.unit, new Error(`Could not write the output of ${name} to ${evidence}: ${writeError.message}`, { cause: writeError }));
      operation.complete();
      checks.push(check);
    });
  }
  return checks;
}

let active = 0;
const waiters: (() => void)[] = [];

export async function withValidationSlot<T>(fn: () => Promise<T>, references: EventReferences = {}, signal?: AbortSignal) {
  const queuedAt = performance.now();
  if (active >= config.harness.maxConcurrentValidations) {
    logger.info({ ...references, event: "validation.waiting", position: waiters.length + 1 });
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const leave = () => { const index = waiters.indexOf(take); if (index >= 0) waiters.splice(index, 1); reject(signal!.reason); };
      const take = () => { signal?.removeEventListener("abort", leave); resolve(); };
      signal?.addEventListener("abort", leave, { once: true });
      waiters.push(take);
    });
  } else active++;
  logger.info({ ...references, event: "validation.started", waitedMs: Math.round(performance.now() - queuedAt) });
  try { return await fn(); }
  finally { const next = waiters.shift(); if (next) next(); else active--; }
}

const quoted = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const segmentSeparator = /\n|;|&&|\|\||\||&|\$\(|\(|\)|`/;
const commandPrefix = /^(?:\w+=\S*\s+|(?:env|nohup|time|sudo|exec)\s+|timeout\s+\d+\S*\s+)+/;

export function heavyCommand(command: string, patterns: RegExp[]) {
  return command.replace(quoted, '""').split(segmentSeparator).map((segment) => segment.replace(/\s+/g, " ").trim().replace(commandPrefix, "").trim())
    .find((segment) => patterns.some((pattern) => pattern.test(segment)));
}

export const backgroundsWork = (command: string) => /(?<![&>|<\\])&(?![&>])|(?:^|[\s;&|(])(?:nohup|setsid|disown)(?=\s|$)/.test(command.replace(quoted, '""'));
