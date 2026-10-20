import type { EventReferences } from "./events.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubComment } from "./github-types.ts";
import { parseIssueCommentId } from "./markers.ts";

export async function upsertComment(github: GitHubRepository, number: number, existing: Pick<GithubComment, "id" | "body"> | undefined, body: string, references: EventReferences) {
  if (!existing) return github.postComment(number, body, references);
  const commentId = parseIssueCommentId(existing.id);
  if (existing.body !== body) await github.updateComment(commentId, body, references);
  return commentId;
}
