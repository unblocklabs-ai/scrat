import { config } from "./config.ts";
import { evaluateGithubContext } from "./github-context.ts";
import type { GithubComment, GithubContext, GithubItem } from "./github-types.ts";
import { labelName } from "./labels.ts";

export const remoteUrl = (repository: string) => `https://github.com/${repository}.git`;
const baseBranchOf = (item: GithubItem) => "base" in item ? item.base.ref : config.github.baseBranch;

export type ItemObservation = {
  repository: string; remote: string; kind: "issue" | "pr"; number: number; item: GithubItem;
  baseBranch: string; headSha?: string; revision: string;
  external: GithubComment[]; own: GithubComment[]; labels: string[];
};

// `headSha` replaces the PR head in the revision, for change runs whose own commits move it.
export function observe(repository: string, context: GithubContext, headSha?: string): ItemObservation {
  const pullRequest = "head" in context.item ? context.item : undefined;
  const item = pullRequest && headSha ? { ...pullRequest, head: { ...pullRequest.head, sha: headSha } } : context.item;
  const { comments: external, revision } = evaluateGithubContext({ ...context, item }, config.github.botLogin);
  return {
    repository, remote: remoteUrl(repository), kind: pullRequest ? "pr" : "issue", number: item.number, item,
    baseBranch: baseBranchOf(item), headSha: "head" in item ? item.head.sha : undefined, revision, external,
    own: context.comments.filter((comment) => comment.author === config.github.botLogin),
    labels: item.labels.map(labelName),
  };
}
