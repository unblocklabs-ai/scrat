import type { GithubComment } from "./github-types.ts";

export const reviewMarker = "<!-- scrat-review -->";
export const taskMarker = (taskId: string) => `<!-- scrat-task:${taskId} -->`;
const issuePrefix = "issue:";

export const issueCommentId = (id: number | undefined) => `${issuePrefix}${id}`;
export const isIssueComment = (comment: Pick<GithubComment, "id">) => comment.id.startsWith(issuePrefix);
export const parseIssueCommentId = (id: string) => Number(id.slice(issuePrefix.length));
export const acknowledgedTaskIds = (body: string) => [...body.matchAll(/<!-- scrat-task:([a-f0-9-]+) -->/g)].map((match) => match[1]);
