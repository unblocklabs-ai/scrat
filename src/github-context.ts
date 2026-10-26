import { createHash } from "node:crypto";
import type { GithubContext } from "./github-types.ts";
import { isBotLogin } from "./config.ts";
import { commentKey } from "./markers.ts";

const digest = (fields: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

export function evaluateGithubContext({ item, comments }: GithubContext) {
  const external = comments.filter((comment) => !isBotLogin(comment.author) && comment.body.trim());
  const pullRequest = "head" in item ? item : undefined;
  const commentKeys = external.map((comment) => commentKey(comment)).sort();
  const described = { title: item.title, body: item.body, head: pullRequest?.head.sha, base: pullRequest?.base.ref, comments: commentKeys };
  const revision = pullRequest ? digest({ head: pullRequest.head.sha, base: pullRequest.base.ref, comments: commentKeys }) : digest(described);
  return { comments: external, revision, priorRevision: pullRequest ? digest(described) : undefined };
}
