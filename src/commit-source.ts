import { commitSettings, config, getRepositoryPath, isBotLogin } from "./config.ts";
import { fetchRepository, git, gitList, isAncestor } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { type OperationScope } from "./logging.ts";
import type { Manifest } from "./manifests.ts";
import { upsertSubject } from "./items.ts";
import { remoteUrl } from "./repository.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

export function pollCommits(repository = config.github.repository) {
  return pollSource("commits.poll", "github_commits", ({ name, trigger }, operation) => pollAction(name, trigger, repository, operation), repository);
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
  const cursor = sourceCursor(repository, action, branch);
  if (!enabled) {
    cursor.clear();
    return 0;
  }
  operation.stage("fetch");
  const repositoryPath = getRepositoryPath();
  const tip = await fetchRepository(repositoryPath, remoteUrl(repository), branch, await new GitHubRepository(repository).getGitEnvironment());
  const cursorSha = cursor.value;
  if (!cursorSha) {
    cursor.save(tip);
    operation.log.info({ event: "commits.seeded", branch, sha: tip });
    return 0;
  }
  if (cursorSha === tip) {
    return 0;
  }
  operation.stage("range");
  let previousSha = cursorSha;
  const known = await git(repositoryPath, ["cat-file", "-e", `${cursorSha}^{commit}`]).then(() => true, () => false);
  if (!known || !await isAncestor(repositoryPath, cursorSha, tip)) {
    const base = known ? await git(repositoryPath, ["merge-base", cursorSha, tip]).catch(() => "") : "";
    if (!base || base === tip) {
      cursor.save(tip);
      operation.log.warn({ event: "commits.cursor_reset", branch, from: cursorSha, sha: tip });
      return 0;
    }
    previousSha = base;
    operation.log.warn({ event: "commits.cursor_rewound", branch, from: cursorSha, to: base });
  }
  if (trigger.granularity === "commit") {
    const matching = (await rangeCommits(repositoryPath, previousSha, tip)).filter((commit) => commitMatches(trigger, commit));
    const kept = matching.slice(0, maxRangeCommits);
    operation.stage("enqueue");
    let queued = 0;
    for (const commit of kept) {
      queued += enqueueCommit({ repository, action, branch, sha: commit.sha, previousSha: commit.parent, commitCount: 1, truncated: false, title: commit.title, author: commit.author });
    }
    cursor.save(matching.length > kept.length ? kept.at(-1)!.sha : tip);
    return queued;
  }
  if ((trigger.author !== undefined || trigger.message !== undefined) && !(await rangeCommits(repositoryPath, previousSha, tip)).some((commit) => commitMatches(trigger, commit))) {
    cursor.save(tip);
    return 0;
  }
  const commitCount = Number(await git(repositoryPath, ["rev-list", "--first-parent", "--count", `${previousSha}..${tip}`]));
  const [author, title] = (await git(repositoryPath, ["log", "-1", "--format=%an%x00%s", tip])).split("\0");
  operation.stage("enqueue");
  const queued = enqueueCommit({ repository, action, branch, sha: tip, previousSha, commitCount, truncated: commitCount > maxRangeCommits, title: title ?? "", author: author ?? "" });
  cursor.save(tip);
  return queued;
}

function enqueueCommit({ repository, action, branch, sha, previousSha, commitCount, truncated, title, author }: {
  repository: string; action: string; branch: string; sha: string; previousSha: string; commitCount: number; truncated: boolean; title: string; author: string;
}) {
  const subject = upsertSubject({
    repository, kind: "commit", key: `${branch}:${sha}`,
    metadata: { title, author, url: `https://github.com/${repository}/commit/${sha}` },
  }, "open");
  return enqueueOnce(subject, action, `${branch} moved to ${sha.slice(0, 7)}`,
    { source: "github_commits", kind: "commit", triggerKey: sha, sha, previousSha, branch, commitCount, truncated });
}
