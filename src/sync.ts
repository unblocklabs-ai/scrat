import { config } from "./config.ts";
import { db } from "./db.ts";
import { syncGitHub } from "./github-sync.ts";

try {
  await syncGitHub(process.argv[2] ?? config.github.repository);
} catch {
  process.exitCode = 1;
} finally {
  db.$client.close();
}
