import { db } from "./db.ts";
import { syncGitHub } from "./github-sync.ts";

try {
  await syncGitHub(process.argv[2]);
} catch {
  process.exitCode = 1;
} finally {
  db.$client.close();
}
