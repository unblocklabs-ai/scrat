import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.change.run({
    context: "feedback",
    files: ["discussion", "issue"],
    acceptance: "complete",
    commitPrefix: "Address feedback",
    publish: ["push", "comment"],
  });
}
