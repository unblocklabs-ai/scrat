import { retryTask } from "./tasks.ts";
import { runCommand } from "./cli.ts";

await runCommand("Retry command failed", async () => {
  const [taskId, ...flags] = process.argv.slice(2);
  if (!taskId || taskId.startsWith("-") || flags.length > 1 || flags.some((flag) => flag !== "--validation-only")) {
    throw new Error("Usage: npm run retry -- <task-id> [--validation-only]");
  }
  retryTask(taskId, flags.length ? "validation" : "repair");
});
