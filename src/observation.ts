import { config, isBotLogin } from "./config.ts";
import { evaluateGithubContext } from "./github-context.ts";
import type { GithubComment, GithubContext, GithubItem } from "./github-types.ts";
import { labelName } from "./labels.ts";

const baseBranchOf = (item: GithubItem) => "base" in item ? item.base.ref : config.github.baseBranch;

export type ItemObservation = {
  kind: "issue" | "pr"; item: GithubItem;
  baseBranch: string; revision: string;
  external: GithubComment[]; own: GithubComment[]; labels: string[];
};

export function observe(context: GithubContext, headSha?: string): ItemObservation {
  const pullRequest = "head" in context.item ? context.item : undefined;
  const item = pullRequest && headSha ? { ...pullRequest, head: { ...pullRequest.head, sha: headSha } } : context.item;
  const { comments: external, revision } = evaluateGithubContext({ ...context, item });
  return {
    kind: pullRequest ? "pr" : "issue", item,
    baseBranch: baseBranchOf(item), revision, external,
    own: context.comments.filter((comment) => isBotLogin(comment.author)),
    labels: item.labels.map(labelName),
  };
}
