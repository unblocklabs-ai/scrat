import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  const rawStart = ctx.workflow.config.start;
  const start = Array.isArray(rawStart)
    ? rawStart.filter((entry): entry is "slack_post" => entry === "slack_post")
    : ["slack_post" as const];
  await ctx.review.run({
    context: "change",
    files: ["discussion", "history"],
    start,
    publish: ["slack_reply"],
  });
}
