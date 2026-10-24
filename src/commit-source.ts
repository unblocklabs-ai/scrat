import { and, eq } from "drizzle-orm";
import { manifests } from "./actions.ts";
import { commitSettings, config, getRepositoryPath, isBotLogin } from "./config.ts";
import { db } from "./db.ts";
import { fetchRepository, git, gitList, isAncestor } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { type OperationScope, withOperation } from "./logging.ts";
import type { Manifest } from "./manifests.ts";
import { assertConfiguredRepository, remoteUrl } from "./repository.ts";
import { sourceCursors, subjects } from "./schema.ts";
import { enqueueTask, latestTask } from "./tasks.ts";

export async function pollCommits(repository = config.github.repository) {
  return withOperation("commits.poll", { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const { name, trigger } of manifests()) {
      if (trigger.source === "github_commits") queued += await pollAction(name, trigger, repository, operation);
    }
    operation.complete({ queued });
    return queued;
  });
}

type CommitTrigger = Manifest["trigger"];
type RangeCommit = { sha: string; parent: string; author: string; email: string; title: string; message: string };

const noreplyLogin = (email: string) => /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];

function commitMatches({ author, message }: CommitTrigger, commit: RangeCommit) {
  const logins = [commit.author, noreplyLogin(commit.email)].filter((login) => login !== undefined).map((login) => login.toLowerCase());
  return (author === undefined || (author === "bot" ? logins.some((login) => isBotLogin(login)) : logins.includes(author.toLowerCase())))
    && (message === undefined || commit.message.includes(message));
}

async function rangeCommits(repositoryPath: string, previousSha: string, tip: string): Promise<RangeCommit[]> {
  const log = await gitList(repositoryPath, ["log", "--first-parent", "--reverse", "-z", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%s%x1f%B", `${previousSha}..${tip}`]);
  return log.map((entry) => {
    const [sha = "", parents = "", author = "", email = "", title = "", ...message] = entry.split("\x1f");
    return { sha: sha.trim(), parent: parents.split(" ")[0] ?? "", author, email, title, message: message.join("\x1f") };
  });
}

async function pollAction(action: string, trigger: CommitTrigger, repository: string, operation: OperationScope) {
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
  if (trigger.granularity === "commit") {
    const matching = (await rangeCommits(repositoryPath, previousSha, tip)).filter((commit) => commitMatches(trigger, commit));
    const kept = matching.slice(0, maxRangeCommits);
    operation.stage("enqueue");
    let queued = 0;
    for (const commit of kept) {
      queued += enqueueCommit({ repository, action, branch, sha: commit.sha, previousSha: commit.parent, commitCount: 1, truncated: false, title: commit.title, author: commit.author });
    }
    saveCursor(matching.length > kept.length ? kept.at(-1)!.sha : tip);
    return queued;
  }
  if ((trigger.author !== undefined || trigger.message !== undefined) && !(await rangeCommits(repositoryPath, previousSha, tip)).some((commit) => commitMatches(trigger, commit))) {
    saveCursor(tip);
    return 0;
  }
  const commitCount = Number(await git(repositoryPath, ["rev-list", "--first-parent", "--count", `${previousSha}..${tip}`]));
  const [author, title] = (await git(repositoryPath, ["log", "-1", "--format=%an%x00%s", tip])).split("\0");
  operation.stage("enqueue");
  const queued = enqueueCommit({ repository, action, branch, sha: tip, previousSha, commitCount, truncated: commitCount > maxRangeCommits, title: title ?? "", author: author ?? "" });
  saveCursor(tip);
  return queued;
}

function enqueueCommit({ repository, action, branch, sha, previousSha, commitCount, truncated, title, author }: {
  repository: string; action: string; branch: string; sha: string; previousSha: string; commitCount: number; truncated: boolean; title: string; author: string;
}) {
  const subject = db.insert(subjects).values({
    repository, kind: "commit", key: `${branch}:${sha}`,
    metadata: { title, author, url: `https://github.com/${repository}/commit/${sha}` },
  }).onConflictDoUpdate({ target: [subjects.repository, subjects.kind, subjects.key], set: { state: "open" } }).returning().get()!;
  if (latestTask(subject.id, action)) return 0;
  enqueueTask({
    subjectId: subject.id, action, reason: `${branch} moved to ${sha.slice(0, 7)}`,
    input: { source: "github_commits", kind: "commit", triggerKey: sha, sha, previousSha, branch, commitCount, truncated },
  });
  return 1;
}
