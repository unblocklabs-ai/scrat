import { mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { fetchOpenItems } from "./github.ts";
import { upsertItem } from "./items.ts";
import { githubSnapshots } from "./schema.ts";

const repository = process.argv[2] ?? config.github.repository;
const startedAt = performance.now();

try {
  const { items, pullRequests } = await fetchOpenItems(repository);
  const fetchedAt = new Date().toISOString();
  const directory = "tmp/responses/github";
  const issues = items.filter((item) => !item.pull_request).length;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/issues-and-pull-requests.json`, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
  await writeFile(`${directory}/pull-requests.json`, JSON.stringify(pullRequests, null, 2) + "\n", { mode: 0o600 });

  db.transaction((transaction) => {
    transaction.insert(githubSnapshots).values({ repository, fetchedAt, items, pullRequests }).run();
    for (const item of items) {
      if (item.pull_request) continue;
      upsertItem({ source: "github", externalId: item.node_id, kind: "issue", payload: item });
    }
    for (const pullRequest of pullRequests) {
      upsertItem({ source: "github", externalId: pullRequest.node_id, kind: "pr", payload: pullRequest });
    }
    recordEvent({
      type: "github.fetch_completed",
      data: { repository, issues, pullRequests: pullRequests.length, durationMs: Math.round(performance.now() - startedAt) },
    }, transaction);
  });

  console.log(JSON.stringify({
    repository, fetchedAt, issues, pullRequests: pullRequests.length,
    responses: directory, database: "data/scrat.sqlite",
  }, null, 2));
} catch (error) {
  const failure = {
    repository,
    durationMs: Math.round(performance.now() - startedAt),
    error: describeError(error),
  };
  recordEvent({ type: "github.fetch_failed", data: failure });
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  db.$client.close();
}
