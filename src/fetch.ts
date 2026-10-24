import { syncGitHub } from "./github-sync.ts";
import { runCommand } from "./cli.ts";

await runCommand("Fetch failed", async () => {
  await syncGitHub(process.argv[2], false);
});
