import type { GithubComment } from "./github-types.ts";

export const reviewMarker = "<!-- scrat-review -->";
const taskMarkerParts = ["<!-- scrat-task:", " -->"] as const;
export const taskMarker = (taskId: string) => `${taskMarkerParts[0]}${taskId}${taskMarkerParts[1]}`;
const issuePrefix = "issue:";

export const issueCommentId = (id: number | undefined) => `${issuePrefix}${id}`;
export const isIssueComment = (comment: Pick<GithubComment, "id">) => comment.id.startsWith(issuePrefix);
export const parseIssueCommentId = (id: string) => Number(id.slice(issuePrefix.length));
export const inlineCommentId = (id: number) => `inline:${id}`;
export const reviewCommentId = (id: number) => `review:${id}`;
const taskMarkerPattern = new RegExp(`${taskMarkerParts[0]}([a-f0-9-]+)${taskMarkerParts[1]}`, "g");
export const acknowledgedTaskIds = (body: string) => [...body.matchAll(taskMarkerPattern)].map((match) => match[1]);

export const commentKey = (comment: Pick<GithubComment, "id" | "revision">) => `${comment.id}@${comment.revision}`;
export const parseCommentKey = (key: string) => key.split("@")[0];
