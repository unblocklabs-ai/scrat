import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.change.run({
    files: ["discussion"],
    acceptance: "conflict_free",
    commitPrefix: "Resolve conflicts",
    publish: ["push", "comment"],
  });
}
