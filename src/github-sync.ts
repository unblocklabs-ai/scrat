import { mkdir, writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { GitHubRepository } from "./github.ts";
import { routeGithubTasks } from "./github-tasks.ts";
import { upsertItem } from "./items.ts";
import { assertConfiguredRepository, itemRepository, sameRepository } from "./observation.ts";
import { withOperation } from "./logging.ts";
import { githubSnapshots, items } from "./schema.ts";

// Raw snapshots are diagnostic only (about 4 h at the default poll); bound them so the SQLite file and its backups stay small.
const snapshotsKept = 48;

export async function syncGitHub(repository = config.github.repository, queueTasks = true) {
  return withOperation(queueTasks ? "github.sync" : "github.fetch", { repository }, async (operation) => {
    operation.stage("repository");
    // Before any read or write; inside the operation so the CLI's silent catch still leaves a log.
    assertConfiguredRepository(repository);
    operation.stage("fetch");
    const previousItems = db.select().from(items).where(eq(items.source, "github")).all()
      .filter((item) => sameRepository(itemRepository(item) ?? "", repository));
    const previous = new Map(previousItems.map((item) => [item.externalId, item]));
    const github = new GitHubRepository(repository);
    const { issues, pullRequests, snapshot } = await github.fetchOpenItems();
    operation.stage("responses");
    await mkdir("tmp/responses/github", { recursive: true });
    await writeFile("tmp/responses/github/issues-and-pull-requests.json", JSON.stringify(snapshot.items, null, 2) + "\n");
    await writeFile("tmp/responses/github/pull-requests.json", JSON.stringify(snapshot.pullRequests, null, 2) + "\n");
    operation.stage("persistence");
    db.transaction((transaction) => {
      transaction.insert(githubSnapshots).values({ repository, fetchedAt: new Date().toISOString(), ...snapshot }).run();
      transaction.run(sql`DELETE FROM github_snapshots WHERE repository = ${repository} AND id <= (SELECT id FROM github_snapshots WHERE repository = ${repository} ORDER BY id DESC LIMIT 1 OFFSET ${snapshotsKept})`);
      for (const payload of issues) upsertItem({ source: "github", externalId: payload.node_id, kind: "issue", payload }, transaction);
      for (const payload of pullRequests) upsertItem({ source: "github", externalId: payload.node_id, kind: "pr", payload }, transaction);
    });
    let queued = 0;
    if (queueTasks) {
      operation.stage("reconcile_closed");
      const openIds = new Set([...issues, ...pullRequests].map((payload) => payload.node_id));
      const missing = previousItems.filter((item) => item.state === "open" && !openIds.has(item.externalId));
      const contexts = await github.fetchItemContexts(missing.map((item) => ({ kind: item.kind, number: item.payload.number })), { comments: false });
      for (const [index, previousItem] of missing.entries()) {
        const context = contexts[index]!;
        upsertItem({ source: "github", externalId: previousItem.externalId, kind: previousItem.kind, payload: context.item, state: context.item.state === "open" ? "open" : "closed" });
      }
      operation.stage("route_tasks");
      const current = db.select().from(items).where(eq(items.source, "github")).all()
        .filter((item) => sameRepository(itemRepository(item) ?? "", repository));
      queued = await routeGithubTasks(github, current, previous, operation.log);
    }
    operation.complete({ issues: issues.length, pullRequests: pullRequests.length, ...(queueTasks ? { queued } : {}) });
    return { issues: issues.length, pullRequests: pullRequests.length, queued };
  });
}
