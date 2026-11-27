import type { GithubComment } from "./github-types.ts";

export const reviewMarker = "<!-- scrat-review -->";
export const previewMarker = "<!-- scrat-preview -->";
export const storefrontMarker = "<!-- scrat-storefront -->";
export const obsoleteCloseMarker = (pullNumber: number) => `<!-- scrat-obsolete-pr:${pullNumber} -->`;
const taskMarkerParts = ["<!-- scrat-task:", " -->"] as const;
export const taskMarker = (taskId: string) => `${taskMarkerParts[0]}${taskId}${taskMarkerParts[1]}`;
const issuePrefix = "issue:";

export const fingerprintPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export function fingerprintMarker(fingerprint: string) {
  if (!fingerprintPattern.test(fingerprint)) throw new Error("Issue fingerprint must match [A-Za-z0-9._:-]{1,128}");
  return `<!-- scrat-fingerprint:${fingerprint} -->`;
}
export const withMarker = (body: string, ...markers: string[]) => `${body.trimEnd()}\n\n${markers.join("\n")}`;
export const endsWithMarker = (body: string, marker: string) => body.trimEnd().endsWith(marker);
const workflowMarkerPrefix = (workflow: string) => `<!-- scrat-workflow:${workflow}:`;
export const workflowCommentMarker = (workflow: string, key: string) => `${workflowMarkerPrefix(workflow)}${key} -->`;
export const advisoryResolvedMarker = "<!-- scrat-advisory-state:resolved -->";
export const issueCommentId = (id: number | undefined) => `${issuePrefix}${id}`;
export const isIssueComment = (comment: Pick<GithubComment, "id">) => comment.id.startsWith(issuePrefix);
export const hasOpenWorkflowComment = (comments: readonly GithubComment[], workflow: string) =>
  comments.some((comment) => isIssueComment(comment) && comment.body.includes(workflowMarkerPrefix(workflow)) && !comment.body.includes(advisoryResolvedMarker));
export const parseIssueCommentId = (id: string) => Number(id.slice(issuePrefix.length));
export const inlineCommentId = (id: number) => `inline:${id}`;
export const reviewCommentId = (id: number) => `review:${id}`;
const taskMarkerPattern = new RegExp(`${taskMarkerParts[0]}([a-f0-9-]+)${taskMarkerParts[1]}`, "g");
export const acknowledgedTaskIds = (body: string) => [...body.matchAll(taskMarkerPattern)].map((match) => match[1]);

export const commentKey = (comment: Pick<GithubComment, "id" | "revision">) => `${comment.id}@${comment.revision}`;
export const parseCommentKey = (key: string) => key.split("@")[0];
