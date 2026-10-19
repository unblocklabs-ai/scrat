import { createHash } from "node:crypto";
import type { GithubContext } from "./github-types.ts";

// Routing, execution, and freshness checks must evaluate the same comments.
// Keep the digest compatible with stored revisions and leave delivery comments intact.
export function evaluateGithubContext({ item, comments }: GithubContext, botLogin: string) {
  const external = comments.filter((comment) => comment.author !== botLogin && comment.body.trim());
  const pullRequest = "head" in item ? item : undefined;
  const revision = createHash("sha256").update(JSON.stringify({
    title: item.title, body: item.body, head: pullRequest?.head.sha, base: pullRequest?.base.ref,
    comments: external.map((comment) => `${comment.id}@${comment.revision}`).sort(),
  })).digest("hex");
  return { comments: external, revision };
}
