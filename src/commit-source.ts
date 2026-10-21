import { and, desc, eq } from "drizzle-orm";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import { fetchRepository, git, isAncestor } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { upsertItem } from "./items.ts";
import { withOperation } from "./logging.ts";
import { assertConfiguredRepository, remoteUrl } from "./observation.ts";
import { sourceCursors, tasks } from "./schema.ts";
import { enqueueTask } from "./tasks.ts";

const action = "review_base_change";

export async function pollCommits(repository = config.github.repository) {
  return withOperation("commits.poll", { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    const { enabled, branch, maxRangeCommits } = config.actions[action];
    const key = and(eq(sourceCursors.repository, repository), eq(sourceCursors.action, action), eq(sourceCursors.branch, branch));
    if (enabled === false) {
      db.delete(sourceCursors).where(key).run();
      operation.complete({ enabled: false });
      return 0;
    }
    operation.stage("fetch");
    const repositoryPath = getRepositoryPath();
    const tip = await fetchRepository(repositoryPath, remoteUrl(repository), branch, await new GitHubRepository(repository).getGitEnvironment());
    const saveCursor = (sha: string) => db.insert(sourceCursors).values({ repository, action, branch, sha, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [sourceCursors.repository, sourceCursors.action, sourceCursors.branch], set: { sha, updatedAt: new Date().toISOString() } }).run();
    const cursor = db.select().from(sourceCursors).where(key).get();
    if (!cursor) {
      saveCursor(tip);
      operation.log.info({ event: "commits.seeded", branch, sha: tip });
      operation.complete({ queued: 0 });
      return 0;
    }
    if (cursor.sha === tip) {
      operation.complete({ queued: 0 });
      return 0;
    }
    operation.stage("range");
    let previousSha = cursor.sha;
    const known = await git(repositoryPath, ["cat-file", "-e", `${cursor.sha}^{commit}`]).then(() => true, () => false);
    if (!known || !await isAncestor(repositoryPath, cursor.sha, tip)) {
      const base = known ? await git(repositoryPath, ["merge-base", cursor.sha, tip]).catch(() => "") : "";
      if (!base || base === tip) {
        saveCursor(tip);
        operation.log.warn({ event: "commits.cursor_reset", branch, from: cursor.sha, sha: tip });
        operation.complete({ queued: 0 });
        return 0;
      }
      previousSha = base;
      operation.log.warn({ event: "commits.cursor_rewound", branch, from: cursor.sha, to: base });
    }
    const commitCount = Number(await git(repositoryPath, ["rev-list", "--first-parent", "--count", `${previousSha}..${tip}`]));
    const [author, subject] = (await git(repositoryPath, ["log", "-1", "--format=%an%x00%s", tip])).split("\0");
    operation.stage("enqueue");
    const item = upsertItem({
      source: "git", externalId: `commit:${branch}:${tip}`, kind: "commit",
      payload: {
        node_id: `commit:${branch}:${tip}`, number: 0, title: subject ?? "", html_url: `https://github.com/${repository}/commit/${tip}`,
        state: "open", updated_at: new Date().toISOString(), user: { login: author ?? "" }, labels: [],
      },
    });
    const existing = db.select().from(tasks).where(and(eq(tasks.itemId, item.id), eq(tasks.action, action)))
      .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1).get();
    if (!existing) {
      enqueueTask({
        itemId: item.id, action, reason: `${branch} moved to ${tip.slice(0, 7)}`,
        input: { kind: "commit", triggerKey: tip, sha: tip, previousSha, branch, commitCount, truncated: commitCount > maxRangeCommits },
      });
    }
    saveCursor(tip);
    operation.complete({ queued: existing ? 0 : 1, sha: tip, commitCount });
    return existing ? 0 : 1;
  });
}
