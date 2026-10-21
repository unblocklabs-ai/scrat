import { and, eq } from "drizzle-orm";
import { manifests } from "./actions.ts";
import { commitSettings, config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import { fetchRepository, git, isAncestor } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { type OperationScope, withOperation } from "./logging.ts";
import { assertConfiguredRepository, remoteUrl } from "./repository.ts";
import { sourceCursors, subjects } from "./schema.ts";
import { enqueueTask, latestTask } from "./tasks.ts";

export async function pollCommits(repository = config.github.repository) {
  return withOperation("commits.poll", { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const { name, trigger } of manifests()) {
      if (trigger.source === "github_commits") queued += await pollAction(name, repository, operation);
    }
    operation.complete({ queued });
    return queued;
  });
}

async function pollAction(action: string, repository: string, operation: OperationScope) {
  const { enabled, branch, maxRangeCommits } = commitSettings(action);
  const key = and(eq(sourceCursors.repository, repository), eq(sourceCursors.action, action), eq(sourceCursors.branch, branch));
  if (!enabled) {
    db.delete(sourceCursors).where(key).run();
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
    return 0;
  }
  if (cursor.sha === tip) {
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
      return 0;
    }
    previousSha = base;
    operation.log.warn({ event: "commits.cursor_rewound", branch, from: cursor.sha, to: base });
  }
  const commitCount = Number(await git(repositoryPath, ["rev-list", "--first-parent", "--count", `${previousSha}..${tip}`]));
  const [author, title] = (await git(repositoryPath, ["log", "-1", "--format=%an%x00%s", tip])).split("\0");
  operation.stage("enqueue");
  const subject = db.insert(subjects).values({
    repository, kind: "commit", key: `${branch}:${tip}`,
    metadata: { title: title ?? "", author: author ?? "", url: `https://github.com/${repository}/commit/${tip}` },
  }).onConflictDoUpdate({ target: [subjects.repository, subjects.kind, subjects.key], set: { state: "open" } }).returning().get()!;
  const existing = latestTask(subject.id, action);
  if (!existing) {
    enqueueTask({
      subjectId: subject.id, action, reason: `${branch} moved to ${tip.slice(0, 7)}`,
      input: { source: "github_commits", kind: "commit", triggerKey: tip, sha: tip, previousSha, branch, commitCount, truncated: commitCount > maxRangeCommits },
    });
  }
  saveCursor(tip);
  return existing ? 0 : 1;
}
