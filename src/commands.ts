import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventReferences } from "./events.ts";
import { startOperation } from "./logging.ts";

const executeFile = promisify(execFile);

export async function runCommands(commands: string[][], cwd: string, environment: NodeJS.ProcessEnv, references: EventReferences = {}) {
  for (const [file, ...args] of commands) {
    const operation = startOperation("workspace.command", { ...references, command: [file, ...args], cwd });
    try {
      const { stdout, stderr } = await executeFile(file, args, { cwd, env: environment, maxBuffer: 16 * 1024 * 1024 });
      operation.complete({ stdout, stderr });
    } catch (error) {
      operation.fail(error);
      throw error;
    }
  }
}
