import { mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { fetchOpenItems } from "./github.ts";
import { upsertItem } from "./items.ts";
import { githubSnapshots } from "./schema.ts";

const repository = process.argv[2] ?? config.github.repository;
const { items, pullRequests } = await fetchOpenItems(repository);
const fetchedAt = new Date().toISOString();
const directory = "tmp/responses/github";
const itemsJson = JSON.stringify(items, null, 2);
const pullRequestsJson = JSON.stringify(pullRequests, null, 2);

await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(`${directory}/issues-and-pull-requests.json`, itemsJson + "\n", { mode: 0o600 });
await writeFile(`${directory}/pull-requests.json`, pullRequestsJson + "\n", { mode: 0o600 });

db.transaction(() => {
  db.insert(githubSnapshots).values({ repository, fetchedAt, items, pullRequests }).run();
  for (const item of items) {
    if (item.pull_request) continue;
    upsertItem({ source: "github", externalId: item.node_id, kind: "issue", payload: item });
  }
  for (const pullRequest of pullRequests) {
    upsertItem({ source: "github", externalId: pullRequest.node_id, kind: "pr", payload: pullRequest });
  }
});
db.$client.close();

console.log(JSON.stringify({
  repository,
  fetchedAt,
  issues: items.filter((item) => !item.pull_request).length,
  pullRequests: pullRequests.length,
  responses: directory,
  database: "data/scrat.sqlite",
}, null, 2));
