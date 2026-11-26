import type { WorkflowContext } from "../../src/workflow-ctx.ts";

type Finding = { path: string; line?: number; title: string; detail: string; remedy: string };

const field = { type: "string", pattern: "\\S" };

const assessmentSchema = (maxFindings: number) => ({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: maxFindings,
      description: "One entry per irreversible or data-destructive hazard. Empty when there is none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "title", "detail", "remedy"],
        properties: {
          path: field,
          line: { type: "integer", minimum: 1 },
          title: field,
          detail: field,
          remedy: field,
        },
      },
    },
  },
});

const heading = "### Irreversible change check";
const short = (sha: string) => sha.slice(0, 12);
const clip = (value: string, max: number) => value.length <= max ? value : max > 0 ? `${value.slice(0, max - 1)}…` : "";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const positive = (ctx: WorkflowContext, key: string) => {
  const value = ctx.workflow.config[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`breaking-change-check config.${key} must be a positive integer`);
  return value;
};

function findingsOf(data: Record<string, unknown> | undefined, maxFindings: number): Finding[] {
  if (!Array.isArray(data?.findings)) throw new Error("breaking-change-check assessment did not submit a findings list");
  if (data.findings.length > maxFindings) throw new Error(`breaking-change-check assessment submitted ${data.findings.length} findings; config.maxFindings is ${maxFindings}`);
  return data.findings.map((entry: Record<string, unknown>) => {
    const path = text(entry.path), title = text(entry.title), detail = text(entry.detail), remedy = text(entry.remedy);
    if (!path || !title || !detail || !remedy) throw new Error("breaking-change-check finding has a blank path, title, detail or remedy");
    return { path, title, detail, remedy, ...typeof entry.line === "number" && Number.isInteger(entry.line) ? { line: entry.line } : {} };
  });
}

function report(head: string, findings: Finding[], maxChars: number) {
  const top = [heading, "", `This PR makes ${findings.length === 1 ? "a change" : "changes"} that a revert cannot undo once deployed:`, "", ""].join("\n");
  const bottom = `\n\nChecked at \`${short(head)}\`. This comment is updated in place on new commits.`;
  const list = findings.map(({ path, line, title, detail, remedy }) => `- **${title}** (\`${path}${line ? `:${line}` : ""}\`)\n  ${detail}\n  _Make it safe:_ ${remedy}`).join("\n");
  return `${top}${clip(list, maxChars - top.length - bottom.length)}${bottom}`;
}

const resolvedReport = (head: string) => `${heading}\n\nResolved at \`${short(head)}\`: no irreversible or data-destructive changes remain in this PR.`;

export default async function breakingChangeCheck(ctx: WorkflowContext) {
  const number = ctx.trigger.item?.number;
  if (!number) throw new Error("breaking-change-check runs only on a pull request");
  const maxFindings = positive(ctx, "maxFindings"), maxCommentChars = positive(ctx, "maxCommentChars");
  const observed = await ctx.step("connect", ctx.trigger.input, () => ctx.item.connect());
  if (!observed.pullRequest) throw new Error("breaking-change-check runs only on a pull request");
  ctx.item.observeTarget(observed);
  ctx.item.assertExpectedTarget(observed);
  const head = observed.pullRequest.head.sha;
  const existing = ctx.item.ownComment(observed, "verdict");
  const publish = async (body: string, resolved: boolean) => {
    await ctx.item.assertLiveTarget(observed);
    await ctx.github.comment({ key: "verdict", number, body, resolved });
  };
  const retract = async () => {
    if (!existing || existing.resolved) return { status: "clean", head };
    await publish(resolvedReport(head), true);
    return { status: "retracted", head };
  };
  if (ctx.trigger.input.pathsMatched === false) return retract();
  const assessment = await ctx.step("assess", { head, maxFindings }, () => ctx.item.withCheckout(observed, { prepare: false }, async (ws) => {
    const res = await ctx.item.runAgent(ws, {
      files: [],
      contextMode: "change",
      submitResult: { schema: assessmentSchema(maxFindings), description: "Submit the irreversible-change findings for this PR (findings: [] when there are none)." },
    });
    return { text: res.text, findings: findingsOf(res.data, maxFindings) };
  }));
  if (!assessment.findings.length) return retract();
  await publish(report(head, assessment.findings, maxCommentChars), false);
  return { status: "flagged", head, findings: assessment.findings };
}
