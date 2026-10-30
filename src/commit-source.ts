import { config, getRepositoryPath, isBotLogin } from "./config.ts";
import { commitOf, git, gitList, isAncestor, shortSha } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { type OperationScope } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { upsertSubject } from "./items.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

export function pollCommits(repository = config.github.repository) {
  return pollSource("commits.poll", "github_commits", repository, pollAction);
}

type CommitTrigger = Action["trigger"];
type RangeCommit = { sha: string; parent: string; author: string; email: string; title: string; message: string };

const noreplyLogin = (email: string) => /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];

async function classify(repositoryPath: string, { sha, author, email, title }: { sha: string; author: string; email: string; title: string }) {
  const pr = /^Merge pull request #(\d+) from /.exec(title)?.[1] ?? / \(#(\d+)\)$/.exec(title)?.[1];
  if (pr) return { pr: Number(pr) };
  if (![author, noreplyLogin(email)].some((login) => login?.toLowerCase() === "shopify[bot]") && !title.startsWith("Update from Shopify for theme ")) return {};
  return { shopify: true, paths: await gitList(repositoryPath, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha]) };
}

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

async function pollAction({ name: action, trigger, enabled, maxRangeCommits }: Action, operation: OperationScope, repository: string) {
  const branch = trigger.branch!;
  const cursor = sourceCursor(repository, action, branch);
  if (enabled === false) {
    cursor.clear();
    return 0;
  }
  operation.stage("fetch");
  const repositoryPath = getRepositoryPath();
  const tip = await new GitHubRepository(repository).fetchBranch(branch);
  if (!cursor.value) {
    cursor.save(tip);
    operation.log.info({ event: "commits.seeded", branch, sha: tip });
    return 0;
  }
  if (cursor.value === tip) {
    return 0;
  }
  operation.stage("range");
  let previousSha = cursor.value;
  const known = await commitOf(repositoryPath, cursor.value) !== undefined;
  if (!known || !await isAncestor(repositoryPath, cursor.value, tip)) {
    const base = known ? await git(repositoryPath, ["merge-base", cursor.value, tip]).catch(() => "") : "";
    if (!base || base === tip) {
      cursor.save(tip);
      operation.log.warn({ event: "commits.cursor_reset", branch, from: cursor.value, sha: tip });
      return 0;
    }
    previousSha = base;
    operation.log.warn({ event: "commits.cursor_rewound", branch, from: cursor.value, to: base });
  }
  if (trigger.granularity === "commit") {
    const matching = (await rangeCommits(repositoryPath, previousSha, tip)).filter((commit) => commitMatches(trigger, commit));
    const kept = matching.slice(0, maxRangeCommits!);
    operation.stage("enqueue");
    let queued = 0;
    for (const commit of kept) {
      queued += enqueueCommit({ repository, action, branch, sha: commit.sha, previousSha: commit.parent, commitCount: 1, truncated: false, title: commit.title, author: commit.author, kind: await classify(repositoryPath, commit) });
    }
    cursor.save(matching.length > kept.length ? kept.at(-1)!.sha : tip);
    return queued;
  }
  if ((trigger.author !== undefined || trigger.message !== undefined) && !(await rangeCommits(repositoryPath, previousSha, tip)).some((commit) => commitMatches(trigger, commit))) {
    cursor.save(tip);
    return 0;
  }
  const commitCount = Number(await git(repositoryPath, ["rev-list", "--first-parent", "--count", `${previousSha}..${tip}`]));
  const [author = "", email = "", title = ""] = (await git(repositoryPath, ["log", "-1", "--format=%an%x00%ae%x00%s", tip])).split("\0");
  operation.stage("enqueue");
  const queued = enqueueCommit({ repository, action, branch, sha: tip, previousSha, commitCount, truncated: commitCount > maxRangeCommits!, title, author, kind: await classify(repositoryPath, { sha: tip, author, email, title }) });
  cursor.save(tip);
  return queued;
}

function enqueueCommit({ repository, action, branch, sha, previousSha, commitCount, truncated, title, author, kind }: {
  repository: string; action: string; branch: string; sha: string; previousSha: string; commitCount: number; truncated: boolean; title: string; author: string;
  kind: Awaited<ReturnType<typeof classify>>;
}) {
  const subject = upsertSubject({
    repository, kind: "commit", key: `${branch}:${sha}`,
    metadata: { title, author, ...kind, url: `https://github.com/${repository}/commit/${sha}` },
  });
  return enqueueOnce(subject, action, `${branch} moved to ${shortSha(sha)}`,
    { source: "github_commits", kind: "commit", triggerKey: sha, sha, previousSha, branch, commitCount, truncated });
}
