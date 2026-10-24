import { runNextTask } from "./runner.ts";
import { prepareService } from "./startup.ts";
import { runCommand } from "./cli.ts";

await runCommand("Run command failed", async () => {
  await prepareService();
  const run = await runNextTask();
  if (run?.error) process.exitCode = 1;
});
