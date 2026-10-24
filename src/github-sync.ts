import { config } from "./config.ts";
import { errorStatus } from "./errors.ts";
import { db } from "./db.ts";
import { GitHubRepository, mapConcurrent } from "./github.ts";
import { routeGithubTasks } from "./github-tasks.ts";
import { upsertItem } from "./items.ts";
import { assertConfiguredRepository, itemsInRepository } from "./repository.ts";
import { withOperation } from "./logging.ts";
import type { GithubContext } from "./github-types.ts";

export async function syncGitHub(repository = config.github.repository, queueTasks = true) {
  return withOperation(queueTasks ? "github.sync" : "github.fetch", { repository }, async (operation) => {
    operation.stage("repository");
    assertConfiguredRepository(repository);
    operation.stage("fetch");
    const previousItems = itemsInRepository(repository);
    const previous = new Map(previousItems.map((item) => [item.externalId, item]));
    const github = new GitHubRepository(repository);
    const { issues, pullRequests } = await github.fetchOpenItems();
    operation.stage("persistence");
    db.transaction((transaction) => {
      for (const payload of issues) upsertItem({ externalId: payload.node_id, kind: "issue", payload }, transaction);
      for (const payload of pullRequests) upsertItem({ externalId: payload.node_id, kind: "pr", payload }, transaction);
    });
    let queued = 0;
    if (queueTasks) {
      operation.stage("reconcile_closed");
      const openIds = new Set([...issues, ...pullRequests].map((payload) => payload.node_id));
      const missing = previousItems.filter((item) => item.state === "open" && !openIds.has(item.externalId));
      const reads = new Array<PromiseSettledResult<GithubContext>>(missing.length);
      await mapConcurrent(missing, async (item, index) => {
        try { reads[index] = { status: "fulfilled", value: await github.fetchItemContext(item.kind, item.payload.number, { comments: false }) }; }
        catch (reason) { reads[index] = { status: "rejected", reason }; }
      });
      for (const [index, previousItem] of missing.entries()) {
        const read = reads[index]!;
        if (read.status === "fulfilled") {
          upsertItem({ externalId: previousItem.externalId, kind: previousItem.kind, payload: read.value.item, state: read.value.item.state === "open" ? "open" : "closed" });
        } else if (errorStatus(read.reason) === 404 || errorStatus(read.reason) === 410) {
          upsertItem({ externalId: previousItem.externalId, kind: previousItem.kind, payload: previousItem.payload, state: "closed" });
        } else {
          operation.log.warn({ event: "github.reconcile_failed", kind: previousItem.kind, number: previousItem.payload.number, err: read.reason });
        }
      }
      operation.stage("route_tasks");
      const current = itemsInRepository(repository);
      queued = await routeGithubTasks(github, current, previous, operation.log);
    }
    operation.complete({ issues: issues.length, pullRequests: pullRequests.length, ...(queueTasks ? { queued } : {}) });
    return { issues: issues.length, pullRequests: pullRequests.length, queued };
  });
}
