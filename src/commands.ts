import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventReferences } from "./events.ts";
import { config } from "./config.ts";
import { logger, withOperation } from "./logging.ts";

const executeFile = promisify(execFile);

export async function runCommands(commands: string[][], cwd: string, environment: NodeJS.ProcessEnv, references: EventReferences = {}) {
  const receipts: { command: string[]; durationMs: number; stdout: string; stderr: string }[] = [];
  for (const [file, ...args] of commands) {
    await withOperation("workspace.command", { ...references, command: [file, ...args], cwd }, async (operation) => {
      const started = performance.now();
      const { stdout, stderr } = await executeFile(file, args, { cwd, env: environment, maxBuffer: 16 * 1024 * 1024 });
      operation.complete();
      receipts.push({ command: [file, ...args], durationMs: Math.round(performance.now() - started), stdout, stderr });
    });
  }
  return receipts;
}

// Heavy checks are bounded by a few in-process slots so concurrent runs cannot exhaust host memory.
let active = 0;
const waiters: (() => void)[] = [];

export async function withValidationSlot<T>(fn: () => Promise<T>, references: EventReferences = {}) {
  const queuedAt = performance.now();
  if (active >= (config.harness.maxConcurrentValidations ?? 3)) {
    logger.info({ ...references, event: "validation.waiting", position: waiters.length + 1 });
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else active++;
  logger.info({ ...references, event: "validation.started", waitedMs: Math.round(performance.now() - queuedAt) });
  try { return await fn(); }
  finally { const next = waiters.shift(); if (next) next(); else active--; }
}

const quoted = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const segmentSeparator = /\n|;|&&|\|\||\||&|\$\(|\(|\)|`/;
const commandPrefix = /^(?:\w+=\S*\s+|(?:env|nohup|time|sudo|exec)\s+|timeout\s+\d+\S*\s+)+/;

// A speed bump for agents, not a sandbox: quoted text is ignored (so commit messages and grep patterns never match,
// and `sh -c '...'` passes), and whitespace is collapsed before matching.
export function blockedCommand(command: string, patterns: RegExp[]) {
  return command.replace(quoted, '""').split(segmentSeparator).map((segment) => segment.replace(/\s+/g, " ").trim().replace(commandPrefix, "").trim())
    .find((segment) => patterns.some((pattern) => pattern.test(segment)));
}
