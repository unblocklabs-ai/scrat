import { mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { fetchOpenItems } from "./github.ts";
import { upsertItem } from "./items.ts";
import { startOperation } from "./logging.ts";
import { githubSnapshots } from "./schema.ts";

const repository = process.argv[2] ?? config.github.repository;
const operation = startOperation("github.fetch", { repository });
let stage = "fetch";

try {
  const { items, pullRequests } = await fetchOpenItems(repository, operation.log);
  const fetchedAt = new Date().toISOString();
  const directory = "tmp/responses/github";
  const issues = items.filter((item) => !item.pull_request);

  stage = "responses";
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/issues-and-pull-requests.json`, JSON.stringify(items, null, 2) + "\n");
  await writeFile(`${directory}/pull-requests.json`, JSON.stringify(pullRequests, null, 2) + "\n");

  stage = "persistence";
  db.transaction((transaction) => {
    transaction.insert(githubSnapshots).values({ repository, fetchedAt, items, pullRequests }).run();
    for (const item of issues) {
      upsertItem({ source: "github", externalId: item.node_id, kind: "issue", payload: item }, transaction);
    }
    for (const pullRequest of pullRequests) {
      upsertItem({ source: "github", externalId: pullRequest.node_id, kind: "pr", payload: pullRequest }, transaction);
    }
  });

  operation.complete({ issues: issues.length, pullRequests: pullRequests.length });
} catch (error) {
  operation.fail(error, { stage });
  process.exitCode = 1;
} finally {
  db.$client.close();
}
