import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.review.run({
    files: ["discussion", "previous_assessment", "cloudflare"],
    publish: ["comment", "labels"],
  });
}
