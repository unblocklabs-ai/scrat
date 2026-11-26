import { isBotLogin } from "./config.ts";
import type { EventReferences } from "./events.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubComment, GithubIssue } from "./github-types.ts";
import { endsWithMarker, fingerprintMarker, isIssueComment, parseIssueCommentId } from "./markers.ts";

export function findBotMarkedComment(comments: readonly GithubComment[], marker: string) {
  return comments.findLast((candidate) => isBotLogin(candidate.author) && isIssueComment(candidate) && endsWithMarker(candidate.body, marker));
}

export function findBotFingerprintedIssue(openIssues: readonly GithubIssue[], fingerprint: string) {
  const marker = fingerprintMarker(fingerprint);
  return openIssues.find((candidate) => isBotLogin(candidate.user?.login) && endsWithMarker(candidate.body ?? "", marker));
}

export async function upsertComment(github: GitHubRepository, number: number, existing: Pick<GithubComment, "id" | "body"> | undefined, body: string, references: EventReferences) {
  if (!existing) return github.postComment(number, body, references);
  const commentId = parseIssueCommentId(existing.id);
  if (existing.body !== body) await github.updateComment(commentId, body, references);
  return commentId;
}
