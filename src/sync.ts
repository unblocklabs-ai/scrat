import { syncGitHub } from "./github-sync.ts";
import { runCommand } from "./cli.ts";

await runCommand("Sync failed", async () => {
  await syncGitHub(process.argv[2]);
});
