import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowContext } from "../../src/workflow-ctx.ts";

type Categories = ReturnType<WorkflowContext["item"]["labelCategories"]>;
type Checkout = Parameters<Parameters<WorkflowContext["item"]["withCheckout"]>[2]>[0];

const execFileAsync = promisify(execFile);
const clip = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

function setting<T>(ctx: WorkflowContext, key: string, valid: (value: unknown) => value is T, expected: string): T {
  const value = ctx.workflow.config[key];
  if (!valid(value)) throw new Error(`label_items config.${key} must be ${expected}`);
  return value;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isFraction = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

async function diffStat(ws: Checkout, maxChars: number) {
  if (!ws.diffPaths.length) return "";
  try {
    const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--stat=240,200", ws.diffBaseSha, ws.headSha], { cwd: ws.path });
    return clip(stdout.trimEnd(), maxChars);
  } catch {
    return clip(ws.diffPaths.join("\n"), maxChars);
  }
}

async function fastPath(ctx: WorkflowContext, ws: Checkout, categories: Categories) {
  if (!ctx.d1.enabled || !setting(ctx, "d1FastPath", isBoolean, "a boolean")) return undefined;
  const minScore = setting(ctx, "d1MinScore", isFraction, "a number from 0 to 1");
  const minMargin = setting(ctx, "d1MinMargin", isFraction, "a number from 0 to 1");
  const maxStateChars = setting(ctx, "d1MaxStateChars", isPositive, "a positive integer");
  const maxDiffStatChars = setting(ctx, "d1MaxDiffStatChars", isPositive, "a positive integer");
  const { item, labels } = ws.observed.observation;
  const kind = ws.observed.pullRequest ? "pull request" : "issue";
  const managed = new Set(categories.flatMap(({ choices }) => choices.map(({ name }) => name)));
  const existing = labels.filter((label) => !managed.has(label));
  const stat = await diffStat(ws, maxDiffStatChars);
  const state = clip([
    `${kind} #${item.number}: ${item.title}`,
    `Existing labels: ${existing.length ? existing.join(", ") : "none"}`,
    stat && `Changed files:\n${stat}`,
    `Body:\n${item.body?.trim() || "(empty)"}`,
  ].filter(Boolean).join("\n\n"), maxStateChars);
  const questions: Record<string, string> = {};
  const keyed = categories.map(({ category, choices }, ci) => choices.map(({ name, description }, chi) => {
    const key = `c${ci}_${chi}`;
    questions[key] = `Does this ${kind} belong to the label "${name}" (${description}) in the "${category}" category? Judge only the "${category}" category.`;
    return { key, name };
  }));
  const res = await ctx.d1.score({ state, questions });
  if (!res.ok) {
    ctx.log.info({ event: "d1.label_fast_path", used: false, d1Ms: res.d1Ms, reason: res.reason, categories: [] });
    return undefined;
  }
  const decisions = categories.map(({ category }, ci) => {
    const ranked = keyed[ci]!.map(({ key, name }) => ({ name, score: res.scores[key] })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const [top, second] = ranked;
    const complete = ranked.every(({ score }) => score !== undefined);
    const margin = second ? top!.score! - second.score! : undefined;
    const accepted = complete && top!.score! >= minScore && (margin === undefined || margin >= minMargin);
    return { category, name: top!.name, score: top!.score, margin, accepted };
  });
  const used = decisions.every(({ accepted }) => accepted);
  ctx.log.info({ event: "d1.label_fast_path", used, d1Ms: res.d1Ms, categories: decisions });
  if (!used) return undefined;
  const chosen = decisions.map(({ category, name }) => ({ category, name }));
  ctx.item.assertLabelSelections(chosen, categories);
  const text = `Classified by d1 decisions: ${decisions.map(({ category, name, score, margin }) => `${category} → ${name} (score ${score!.toFixed(2)}${margin === undefined ? "" : `, margin ${margin.toFixed(2)}`})`).join("; ")}.`;
  const result = { outcome: "complete" as const, ready: false, labels: chosen, paths: ws.diffPaths, text };
  ctx.item.recordResult(result);
  return result;
}

export default async function labelItems(ctx: WorkflowContext) {
  const categories = ctx.item.labelCategories();
  if (!categories.length) {
    throw new Error(`label_items has no label categories configured for ${ctx.trigger.item?.kind ?? "item"}`);
  }
  const saved = ctx.item.savedResult();
  let expectedKey: string;
  let result;
  if (saved?.labelingKey) {
    expectedKey = saved.labelingKey;
    result = saved.result;
  } else {
    const observed = await ctx.item.connect();
    expectedKey = ctx.item.labelKey(observed, categories);
    result = await ctx.item.withCheckout(observed, { prepare: false, labelingCategories: categories }, async (ws) =>
      await fastPath(ctx, ws, categories) ?? ctx.item.runAgent(ws, {
        files: [],
        contextMode: "change",
        labelCategories: categories,
      }),
    );
  }
  const current = await ctx.item.connect();
  await ctx.item.assertFreshForPublication(current, { labelKey: expectedKey, labelCategories: categories });
  const labels = result.labels;
  ctx.item.assertLabelSelections(labels, categories);
  const desired = labels.map(({ name }) => name);
  const managed = categories.flatMap(({ choices }) => choices.map(({ name }) => name));
  await ctx.item.reconcileLabels({ key: `labels-${expectedKey.slice(0, 32)}`, current, desired, managed });
  return result;
}
