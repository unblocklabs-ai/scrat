import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.change.run({
    files: ["discussion", "review", "issue"],
    acceptance: "complete",
    commitPrefix: "Address review",
    publish: ["push", "comment"],
  });
}
