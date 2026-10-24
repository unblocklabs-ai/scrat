import { runNextTask } from "./runner.ts";
import { validateStaticConfig } from "./startup.ts";
import { runCommand } from "./cli.ts";

await runCommand("Run command failed", async () => {
  await validateStaticConfig();
  const run = await runNextTask();
  if (run?.error) process.exitCode = 1;
});
