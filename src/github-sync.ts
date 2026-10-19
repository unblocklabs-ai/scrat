import { mkdir, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { GitHubRepository } from "./github.ts";
import { routeGithubTasks } from "./github-tasks.ts";
import { upsertItem } from "./items.ts";
import { startOperation } from "./logging.ts";
import { githubSnapshots, items } from "./schema.ts";

export async function syncGitHub(repository = config.github.repository, queueTasks = true) {
  const operation = startOperation(queueTasks ? "github.sync" : "github.fetch", { repository });
  let stage = "fetch";
  try {
    const previousItems = db.select().from(items).where(eq(items.source, "github")).all()
      .filter((item) => item.payload.html_url.startsWith(`https://github.com/${repository}/`));
    const previous = new Map(previousItems.map((item) => [item.externalId, item]));
    const github = new GitHubRepository(repository);
    const { issues, pullRequests, snapshot } = await github.fetchOpenItems();
    stage = "responses";
    await mkdir("tmp/responses/github", { recursive: true });
    await writeFile("tmp/responses/github/issues-and-pull-requests.json", JSON.stringify(snapshot.items, null, 2) + "\n");
    await writeFile("tmp/responses/github/pull-requests.json", JSON.stringify(snapshot.pullRequests, null, 2) + "\n");
    stage = "persistence";
    db.transaction((transaction) => {
      transaction.insert(githubSnapshots).values({ repository, fetchedAt: new Date().toISOString(), ...snapshot }).run();
      for (const payload of issues) upsertItem({ source: "github", externalId: payload.node_id, kind: "issue", payload }, transaction);
      for (const payload of pullRequests) upsertItem({ source: "github", externalId: payload.node_id, kind: "pr", payload }, transaction);
    });
    let queued = 0;
    if (queueTasks) {
      stage = "reconcile_closed";
      const openIds = new Set([...issues, ...pullRequests].map((payload) => payload.node_id));
      const missing = previousItems.filter((item) => item.state === "open" && !openIds.has(item.externalId));
      const contexts = await github.fetchItemContexts(missing.map((item) => ({ kind: item.kind, number: item.payload.number })), false);
      for (const [index, previousItem] of missing.entries()) {
        const context = contexts[index];
        upsertItem({ source: "github", externalId: previousItem.externalId, kind: previousItem.kind, payload: context.item, state: context.item.state === "open" ? "open" : "closed" });
      }
      stage = "route_tasks";
      const current = db.select().from(items).where(eq(items.source, "github")).all()
        .filter((item) => item.payload.html_url.startsWith(`https://github.com/${repository}/`));
      queued = await routeGithubTasks(github, current, previous, operation.log);
    }
    operation.complete({ issues: issues.length, pullRequests: pullRequests.length, ...(queueTasks ? { queued } : {}) });
    return { issues: issues.length, pullRequests: pullRequests.length, queued };
  } catch (error) {
    operation.fail(error, { stage });
    throw error;
  }
}
