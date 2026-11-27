import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowContext } from "../../src/workflow-ctx.ts";

type Categories = ReturnType<WorkflowContext["item"]["labelCategories"]>;
type Checkout = Parameters<Parameters<WorkflowContext["item"]["withCheckout"]>[2]>[0];

const execFileAsync = promisify(execFile);

function setting<T>(ctx: WorkflowContext, key: string, valid: (value: unknown) => value is T, expected: string): T {
  const value = ctx.workflow.config[key];
  if (!valid(value)) throw new Error(`label_items config.${key} must be ${expected}`);
  return value;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isFraction = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function formatCompactNumstat(raw: string): string {
  const groups = new Map<string, string[]>();
  let files = 0, addedTotal = 0, deletedTotal = 0;
  for (const record of raw.split("\0")) {
    const first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    if (first === -1 || second === -1) continue;
    const addedRaw = record.slice(0, first), deletedRaw = record.slice(first + 1, second), path = record.slice(second + 1);
    if (!path) continue;
    files++;
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? 0 : Number(addedRaw) || 0;
    const deleted = binary ? 0 : Number(deletedRaw) || 0;
    addedTotal += added;
    deletedTotal += deleted;
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "." : path.slice(0, slash + 1);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const delta = binary ? "binary" : `+${added}/-${deleted}`;
    const entries = groups.get(dir) ?? [];
    entries.push(`${name} (${delta})`);
    groups.set(dir, entries);
  }
  if (!files) return "";
  const lines = [`${files} file${files === 1 ? "" : "s"} changed (+${addedTotal}/-${deletedTotal})`];
  for (const [dir, entries] of groups) {
    lines.push(dir === "." ? entries.join(", ") : `${dir}: ${entries.join(", ")}`);
  }
  return lines.join("\n");
}

type DiffStatResult = { ok: true; text: string } | { ok: false; reason: string; detail?: Record<string, unknown> };

async function diffStat(ctx: WorkflowContext, ws: Checkout, limits: { maxChars: number; timeoutMs: number }): Promise<DiffStatResult> {
  if (!ws.diffPaths.length) return { ok: true, text: "" };
  try {
    const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "diff", "--numstat", "-z", "--no-renames", ws.diffBaseSha, ws.headSha], {
      cwd: ws.path, env: { PATH: process.env.PATH }, signal: ctx.signal, timeout: limits.timeoutMs, killSignal: "SIGKILL", maxBuffer: Infinity,
    });
    const stat = formatCompactNumstat(stdout);
    if (limits.maxChars > 0 && stat.length > limits.maxChars) {
      return { ok: false, reason: "diff stat exceeds d1MaxDiffStatChars", detail: { diffStatChars: stat.length, maxDiffStatChars: limits.maxChars, fileCount: ws.diffPaths.length } };
    }
    return { ok: true, text: stat };
  } catch (error) {
    return { ok: false, reason: "diff stat git error", detail: { error: error instanceof Error ? error.message.slice(0, 200) : String(error) } };
  }
}

const skip = (ctx: WorkflowContext, reason: string, d1Ms = 0, extra: Record<string, unknown> = {}) => {
  ctx.log.info({ event: "d1.label_fast_path", used: false, d1Ms, reason, categories: [], ...extra });
  return undefined;
};

async function fastPath(ctx: WorkflowContext, ws: Checkout, categories: Categories) {
  if (!ctx.d1.enabled || !setting(ctx, "d1FastPath", isBoolean, "a boolean")) return undefined;
  const minScore = setting(ctx, "d1MinScore", isFraction, "a number from 0 to 1");
  const minMargin = setting(ctx, "d1MinMargin", isFraction, "a number from 0 to 1");
  const maxStateChars = setting(ctx, "d1MaxStateChars", isNonNegative, "a non-negative integer");
  const maxDiffStatChars = setting(ctx, "d1MaxDiffStatChars", isNonNegative, "a non-negative integer");
  const gitTimeoutMs = setting(ctx, "d1GitTimeoutMs", isPositive, "a positive integer");
  const { item } = ws.observed.observation;
  const kind = ws.observed.pullRequest ? "pull request" : "issue";
  const statRes = await diffStat(ctx, ws, { maxChars: maxDiffStatChars, timeoutMs: gitTimeoutMs });
  if (!statRes.ok) return skip(ctx, statRes.reason, 0, statRes.detail);
  const stat = statRes.text;
  let bodyText = item.body?.trim() || "(empty)";
  const buildState = (body: string) => [
    `${kind} #${item.number}: ${item.title}`,
    stat && `Changed files:\n${stat}`,
    `Body:\n${body}`,
  ].filter(Boolean).join("\n\n");
  let state = buildState(bodyText);
  let extractMs = 0;
  if (maxStateChars > 0 && state.length > maxStateChars) {
    const overhead = state.length - bodyText.length;
    const room = maxStateChars - overhead;
    if (room > 0) {
      const extracted = await ctx.d1.extract({
        state: bodyText,
        fields: {
          summary: {
            type: "text",
            instructions: `In at most ${room} characters, concisely summarize the behavior changes, risk-relevant surfaces (auth, security, migrations, billing, routing, flags, UI), and scope described in this text.`,
          },
        },
      });
      extractMs = extracted.d1Ms;
      if (extracted.ok && typeof extracted.answers.summary?.value === "string" && extracted.answers.summary.value.trim()) {
        bodyText = extracted.answers.summary.value.trim();
        state = buildState(bodyText);
      }
    }
    if (state.length > maxStateChars) {
      return skip(ctx, "state exceeds d1MaxStateChars", extractMs, { stateChars: state.length, maxStateChars });
    }
  }
  const questions: Record<string, string> = {};
  const keyed = categories.map(({ category, choices }, ci) => {
    const choiceList = choices.map(({ name, description }) => `"${name}" (${description})`).join("; ");
    const precedence = /risk/i.test(category)
      ? " For overlapping risk choices, select ONLY the highest applicable risk level."
      : " Select ONLY the single best matching choice.";
    return choices.map(({ name, description }, chi) => {
      const key = `c${ci}_${chi}`;
      questions[key] = `In the mutually exclusive "${category}" category, the allowed choices are: ${choiceList}.${precedence} Is "${name}" (${description}) the single best label for this ${kind} rather than any other choice in "${category}"?`;
      return { key, name };
    });
  });
  const res = await ctx.d1.score({ state, questions });
  if (!res.ok) return skip(ctx, res.reason, extractMs + res.d1Ms);
  const decisions = categories.map(({ category }, ci) => {
    const scores = Object.fromEntries(keyed[ci]!.map(({ key, name }) => [name, res.scores[key]]));
    const ranked = keyed[ci]!.map(({ key, name }) => ({ name, score: res.scores[key] })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const [top, second] = ranked;
    const complete = ranked.every(({ score }) => score !== undefined);
    const margin = second ? top!.score! - second.score! : undefined;
    const qualifying = ranked.filter(({ score }) => score !== undefined && score >= minScore).length;
    const accepted = complete && qualifying === 1 && (margin === undefined || margin >= minMargin);
    return { category, name: top!.name, score: top!.score, margin, qualifying, accepted, scores };
  });
  const used = decisions.every(({ accepted }) => accepted);
  ctx.log.info({ event: "d1.label_fast_path", used, d1Ms: extractMs + res.d1Ms, stateChars: state.length, diffStatChars: stat.length, categories: decisions });
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
