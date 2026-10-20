import { createHash } from "node:crypto";
import type { GithubContext } from "./github-types.ts";
import { isBotLogin } from "./config.ts";
import { commentKey } from "./markers.ts";

export function evaluateGithubContext({ item, comments }: GithubContext) {
  const external = comments.filter((comment) => !isBotLogin(comment.author) && comment.body.trim());
  const pullRequest = "head" in item ? item : undefined;
  const revision = createHash("sha256").update(JSON.stringify({
    title: item.title, body: item.body, head: pullRequest?.head.sha, base: pullRequest?.base.ref,
    comments: external.map((comment) => commentKey(comment)).sort(),
  })).digest("hex");
  return { comments: external, revision };
}
