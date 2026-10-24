import { enqueueManualTasks } from "./tasks.ts";
import { runCommand } from "./cli.ts";

await runCommand("Task enqueue failed", async () => {
  const args = process.argv.slice(2);
  const inline = args.findIndex((arg) => arg.startsWith("--priority="));
  const flag = args.indexOf("--priority");
  const priority = inline >= 0 ? Number(args.splice(inline, 1)[0].slice("--priority=".length))
    : flag < 0 ? undefined : Number(args.splice(flag, 2)[1]);
  const [action, ...targets] = args;
  if (!action || !targets.length) throw new Error("Usage: npm run enqueue -- <action> <number|item-id>... [--priority N]");
  if (priority !== undefined && !Number.isSafeInteger(priority)) throw new Error("Priority must be an integer");
  for (const { target, number, itemId, taskId, error } of enqueueManualTasks(action, targets, priority)) {
    console.log([target, number ?? "-", itemId ?? "-", error ? `error: ${error}` : taskId].join("\t"));
    if (error) process.exitCode = 1;
  }
});
