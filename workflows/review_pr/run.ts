import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.review.run({
    agent: "panel",
    files: ["discussion", "previous_assessment", "previous_repair", "validation", "issue", "storefront"],
    publish: ["pr_assessment"],
  });
}
