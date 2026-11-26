import type { WorkflowContext } from "../../src/workflow-ctx.ts";

type Finding = { path: string; line?: number; title: string; detail: string; remedy: string };

const assessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "One entry per irreversible or data-destructive hazard. Empty when there is none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "title", "detail", "remedy"],
        properties: {
          path: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1 },
          detail: { type: "string", minLength: 1 },
          remedy: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const heading = "### Irreversible change check";
const resolvedLine = "Resolved at";
const short = (sha: string) => sha.slice(0, 12);

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const findingsOf = (data: Record<string, unknown> | undefined): Finding[] => (Array.isArray(data?.findings) ? data.findings : []).flatMap((entry: Record<string, unknown>) => {
  const path = text(entry.path), title = text(entry.title), detail = text(entry.detail), remedy = text(entry.remedy);
  if (!path || !title || !detail || !remedy) return [];
  return [{ path, title, detail, remedy, ...typeof entry.line === "number" && Number.isInteger(entry.line) ? { line: entry.line } : {} }];
});

const report = (head: string, findings: Finding[]) => [
  heading,
  "",
  `This PR makes ${findings.length === 1 ? "a change" : "changes"} that a revert cannot undo once deployed:`,
  "",
  ...findings.map(({ path, line, title, detail, remedy }) => `- **${title}** (\`${path}${line ? `:${line}` : ""}\`)\n  ${detail}\n  _Make it safe:_ ${remedy}`),
  "",
  `Checked at \`${short(head)}\`. This comment is updated in place on new commits.`,
].join("\n");

const resolved = (head: string) => `${heading}\n\n${resolvedLine} \`${short(head)}\`: no irreversible or data-destructive changes remain in this PR.`;

export default async function breakingChangeCheck(ctx: WorkflowContext) {
  const number = ctx.trigger.item?.number;
  if (!number) throw new Error("breaking-change-check runs only on a pull request");
  const observed = await ctx.step("connect", ctx.trigger.input, () => ctx.item.connect());
  if (!observed.pullRequest) throw new Error("breaking-change-check runs only on a pull request");
  const head = observed.pullRequest.head.sha;
  const marker = `<!-- scrat-workflow:${ctx.workflow.name}:verdict -->`;
  const existing = observed.observation.own.findLast((comment) => comment.body.trimEnd().endsWith(marker));
  const flagged = existing !== undefined && !existing.body.includes(`\n${resolvedLine} `);
  const retract = async () => {
    if (!flagged) return { status: "clean", head };
    await ctx.github.comment({ key: "verdict", number, body: resolved(head) });
    return { status: "retracted", head };
  };
  if (ctx.trigger.input.pathsMatched === false) return retract();
  const assessment = await ctx.step("assess", { head }, () => ctx.item.withCheckout(observed, { prepare: false }, async (ws) => {
    const res = await ctx.item.runAgent(ws, {
      files: [],
      contextMode: "change",
      submitResult: { schema: assessmentSchema, description: "Submit the irreversible-change findings for this PR (findings: [] when there are none)." },
    });
    return { text: res.text, findings: findingsOf(res.data) };
  }));
  if (!assessment.findings.length) return retract();
  await ctx.github.comment({ key: "verdict", number, body: report(head, assessment.findings) });
  return { status: "flagged", head, findings: assessment.findings };
}
