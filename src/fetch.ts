import { mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { fetchOpenItems } from "./github.ts";
import { upsertItem } from "./items.ts";
import { startOperation } from "./logging.ts";
import { githubSnapshots } from "./schema.ts";

const repository = process.argv[2] ?? config.github.repository;
const operation = startOperation("github.fetch", { repository });
const references = { operationId: operation.operationId };
const startedAt = performance.now();
let stage = "fetch";

try {
  const { items, pullRequests } = await fetchOpenItems(repository, references);
  const fetchedAt = new Date().toISOString();
  const directory = "tmp/responses/github";
  const issues = items.filter((item) => !item.pull_request).length;

  stage = "responses";
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/issues-and-pull-requests.json`, JSON.stringify(items, null, 2) + "\n");
  await writeFile(`${directory}/pull-requests.json`, JSON.stringify(pullRequests, null, 2) + "\n");

  stage = "persistence";
  db.transaction((transaction) => {
    transaction.insert(githubSnapshots).values({ repository, fetchedAt, items, pullRequests }).run();
    for (const item of items) {
      if (item.pull_request) continue;
      upsertItem({ source: "github", externalId: item.node_id, kind: "issue", payload: item }, references);
    }
    for (const pullRequest of pullRequests) {
      upsertItem({ source: "github", externalId: pullRequest.node_id, kind: "pr", payload: pullRequest }, references);
    }
    recordEvent({
      ...references,
      type: "github.fetch_completed",
      data: { repository, issues, pullRequests: pullRequests.length, durationMs: Math.round(performance.now() - startedAt) },
    }, transaction);
  });

  operation.complete({ issues, pullRequests: pullRequests.length });
} catch (error) {
  operation.fail(error, { stage });
  const failure = {
    repository,
    durationMs: Math.round(performance.now() - startedAt),
    error: describeError(error),
  };
  try {
    recordEvent({ ...references, type: "github.fetch_failed", data: failure });
  } catch { /* Journal failure is logged separately; the operation error is already on stderr. */ }
  process.exitCode = 1;
} finally {
  db.$client.close();
}
