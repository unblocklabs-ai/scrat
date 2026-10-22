import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventReferences } from "./events.ts";
import { config } from "./config.ts";
import { logger, withOperation } from "./logging.ts";
import { sandboxCommand } from "./sandbox.ts";

const executeFile = promisify(execFile);

export async function runCommands(commands: string[][], cwd: string, environment: NodeJS.ProcessEnv, references: EventReferences = {}) {
  const receipts: { command: string[]; durationMs: number; stdout: string; stderr: string }[] = [];
  for (const [file, ...args] of commands) {
    await withOperation("workspace.command", { ...references, command: [file, ...args], cwd }, async (operation) => {
      const started = performance.now();
      const command = sandboxCommand(cwd, file, args, environment);
      const { stdout, stderr } = await executeFile(command.file, command.args, { cwd, env: command.env, maxBuffer: 16 * 1024 * 1024, timeout: config.harness.commandTimeoutSeconds * 1000, killSignal: "SIGKILL" }).catch((error) => {
        if (error instanceof Error && "killed" in error && error.killed) error.message = `Command timed out after ${config.harness.commandTimeoutSeconds} seconds: ${[file, ...args].join(" ")}`;
        throw error;
      });
      operation.complete();
      receipts.push({ command: [file, ...args], durationMs: Math.round(performance.now() - started), stdout, stderr });
    });
  }
  return receipts;
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
