import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function (ctx: WorkflowContext) {
  await ctx.change.run({
    files: ["discussion", "triage", "cloudflare"],
    acceptance: "nonempty_diff",
    publish: ["push", "pull_request"],
  });
}
