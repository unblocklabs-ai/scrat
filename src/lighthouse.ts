import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withValidationSlot } from "./commands.ts";
import { config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { shortSha } from "./git.ts";
import { launchChromium, loadPlaywright } from "./scoped-tools.ts";
import { readState, writeState } from "./storefront.ts";

const categories = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best Practices", seo: "SEO" } as const;
const metrics = {
  "first-contentful-paint": { label: "FCP", divisor: 1000, digits: 1, unit: " s" },
  "largest-contentful-paint": { label: "LCP", divisor: 1000, digits: 1, unit: " s" },
  "total-blocking-time": { label: "TBT", divisor: 1, digits: 0, unit: " ms" },
  "cumulative-layout-shift": { label: "CLS", divisor: 1, digits: 2, unit: "" },
  "speed-index": { label: "Speed Index", divisor: 1000, digits: 1, unit: " s" },
} as const;
const devices = ["mobile", "desktop"] as const;
type Category = keyof typeof categories;
type Device = typeof devices[number];
type Metric = keyof typeof metrics;
type Scores = Record<Category, number>;
type Metrics = Record<Metric, number>;
type Insight = { id: string; title: string; score: number | null; displayValue?: string; metricSavings?: Record<string, number>; items?: Record<string, string | number | boolean>[]; runs?: number };
type AgenticBrowsing = { passed: number; total: number; failed: { id: string; title: string; displayValue?: string }[] };
type Run = { device: Device; page: string; run: number; scores?: Scores; metrics?: Metrics; report?: string; error?: string; insights?: Insight[]; agenticBrowsing?: AgenticBrowsing };
export type LighthouseOptions = { pages?: string[]; runs?: number; devices?: Device[]; timeoutSeconds?: number; includeAgenticBrowsing?: boolean; previewThemeId?: number };
type LighthouseGroup = { runs: number; scored: number; scores?: Scores; metrics?: Metrics; topInsights: Insight[]; agenticBrowsing?: AgenticBrowsing };
export type StorefrontLighthouseSummary = { devices: Partial<Record<Device, LighthouseGroup>>; pages: Record<string, Partial<Record<Device, LighthouseGroup>>>; errors: { device: Device; page: string; run: number; error: string }[]; reports: string[] };
type Delta = { before: number; after: number; delta: number };
type Previous = Partial<Record<Device, { sha: string; scores: Scores; metrics?: Metrics }>>;

const insightIds = ["lcp-breakdown-insight", "lcp-discovery-insight", "cls-culprits-insight", "render-blocking-insight", "image-delivery-insight", "third-parties-insight", "forced-reflow-insight", "duplicated-javascript-insight", "legacy-javascript-insight", "font-display-insight", "dom-size-insight", "document-latency-insight", "network-dependency-tree-insight", "cache-insight", "inp-breakdown-insight", "viewport-insight", "modern-http-insight", "unused-javascript", "unused-css-rules"];
const ids = Object.keys(categories) as Category[], metricIds = Object.keys(metrics) as Metric[];

export async function loadLighthouse() {
  const specifier = "lighthouse";
  return await import(specifier).catch((error: unknown) => {
    throw new Error("Storefront Lighthouse runs need the optional lighthouse package, which is not installed (see the README storefront section)", { cause: error });
  }) as { default: unknown };
}

const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => done(port));
  });
});

const auditScript = fileURLToPath(new URL("./lighthouse-audit.ts", import.meta.url));
const labelled = (table: Record<string, { label: string }>) => Object.fromEntries(Object.entries(table).map(([id, { label }]) => [id, label]));

const childAudit = (input: string, signal: AbortSignal) => new Promise<{ scores: Scores; metrics: Metrics; insights?: Insight[]; agenticBrowsing?: AgenticBrowsing }>((done, fail) => {
  const child = spawn(process.execPath, [auditScript, input], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }), out: Buffer[] = [], err: Buffer[] = [];
  const abort = () => { child.kill("SIGKILL"); };
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.once("error", fail);
  child.once("close", (code) => {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) return fail(signal.reason);
    if (code !== 0) return fail(new Error(Buffer.concat(err).toString().slice(-config.harness.maxStderrBytes).trim() || `Lighthouse exited with code ${code}`));
    try { done(JSON.parse(Buffer.concat(out).toString())); } catch (error) { fail(error); }
  });
});

async function warmPreviewTheme(port: number, origin: string, themeId: number, signal: AbortSignal) {
  const client = await (await loadPlaywright()).chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = client.contexts()[0]!, page = await context.newPage();
    let served: unknown;
    for (let attempt = 0; attempt < 2 && served !== themeId; attempt++) {
      signal.throwIfAborted();
      await page.goto(`${origin}/?preview_theme_id=${themeId}`, { waitUntil: "load", timeout: config.tools.browser.navigationSeconds * 1000 });
      served = await page.evaluate!<unknown>("window.Shopify?.theme?.id");
      if (typeof served === "string") served = Number(served);
    }
    if (served !== themeId) throw new Error(`The preview theme ${themeId} was not served: the store served ${typeof served === "number" ? `theme ${served}` : "no theme"}`);
    await (await context.newCDPSession(page)).send("Network.clearBrowserCache");
    await page.close();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function audited(url: string, device: Device, reportPath: string, signal: AbortSignal, { includeAgenticBrowsing, previewThemeId }: { includeAgenticBrowsing: boolean; previewThemeId?: number }) {
  const port = await freePort(), browser = await launchChromium([`--remote-debugging-port=${port}`]), { max, items, valueChars } = config.storefront.lighthouse.insights;
  try {
    if (previewThemeId !== undefined) await warmPreviewTheme(port, new URL(url).origin, previewThemeId, signal);
    const flags = { port, output: "json", logLevel: "error", onlyCategories: includeAgenticBrowsing ? [...ids, "agentic-browsing"] : ids, disableFullPageScreenshot: true, ...previewThemeId !== undefined ? { disableStorageReset: true } : {} };
    return await childAudit(JSON.stringify({ url, device, reportPath, flags, categories, metrics: labelled(metrics), insightIds, agentic: includeAgenticBrowsing, maxInsights: max, maxItems: items, valueChars }), signal);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function runLighthouse(origin: string, directory: string, references: EventReferences, stop?: AbortSignal, options: LighthouseOptions = {}) {
  const { runs = config.storefront.lighthouse.runs, pages = config.storefront.lighthouse.pages, timeoutSeconds = config.storefront.lighthouse.timeoutSeconds, devices: wanted = [...devices], includeAgenticBrowsing = true, previewThemeId } = options;
  if (!pages.length || pages.some((page) => !/^\/(?!\/)/.test(page))) throw new Error("Lighthouse pages must each start with a single /");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("Lighthouse runs must be a positive integer");
  if (!wanted.length || wanted.some((device) => !devices.includes(device))) throw new Error(`Lighthouse devices must be from ${devices.join(", ")}`);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("Lighthouse timeoutSeconds must be 0 or more");
  if (previewThemeId !== undefined && (!Number.isSafeInteger(previewThemeId) || previewThemeId < 1)) throw new Error("Lighthouse previewThemeId must be a positive integer");
  await loadLighthouse();
  await mkdir(directory, { recursive: true });
  return withValidationSlot(async () => {
    const budget = timeoutSeconds ? AbortSignal.timeout(timeoutSeconds * 1000) : undefined, signal = AbortSignal.any([budget, stop].filter((item) => item !== undefined)), results: Run[] = [];
    for (const device of devices.filter((name) => wanted.includes(name))) for (const [index, page] of pages.entries()) for (let run = 1; run <= runs; run++) {
      if (stop?.aborted) throw stop.reason;
      if (budget?.aborted) { results.push({ device, page, run, error: `not run, the ${timeoutSeconds}s budget was spent` }); continue; }
      try {
        const path = join(directory, `${device}-${index + 1}-${run}.json`);
        const { scores, metrics, insights, agenticBrowsing } = await audited(new URL(page, origin).href, device, path, signal, { includeAgenticBrowsing, previewThemeId });
        results.push({ device, page, run, scores, metrics, report: path, insights, agenticBrowsing });
      } catch (error) {
        if (stop?.aborted) throw error;
        results.push({ device, page, run, error: budget?.aborted ? `stopped when the ${timeoutSeconds}s budget was spent` : errorMessage(error).replace(/\s+/g, " ") });
      }
    }
    return results;
  }, references, stop);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const average = (scored: Scores[]) => Object.fromEntries(ids.map((id) => [id, Math.round(mean(scored.map((scores) => scores[id])))])) as Scores;
const shownUnits = (id: Metric, raw: number) => Number((raw / metrics[id].divisor).toFixed(metrics[id].digits));
const averageMetrics = (measured: Metrics[]) => Object.fromEntries(metricIds.map((id) => [id, shownUnits(id, mean(measured.map((values) => values[id])))])) as Metrics;
const signed = (value: number, digits = 0) => {
  const text = Math.abs(value).toFixed(digits);
  return Number(text) === 0 ? `±${text}` : `${value > 0 ? "+" : "-"}${text}`;
};
const formatMetric = (id: Metric, value: number) => `${value.toFixed(metrics[id].digits)}${metrics[id].unit}`;
const capitalised = (device: Device) => device[0]!.toUpperCase() + device.slice(1);

export async function recordLighthouse(results: Run[], sha: string, state: string) {
  const previous = await readState<Previous>(join(state, "lighthouse.json"), {}) ?? {}, current: Previous = {};
  const slack: string[] = [], missing: string[] = [], columns: { device: Device; cells: string[] }[] = [];
  for (const device of devices) {
    const all = results.filter((run) => run.device === device), scored = all.filter((run) => run.scores && run.metrics);
    if (!all.length) continue;
    if (!scored.length) {
      const line = `Lighthouse ${device}: no result (${all[0]!.error})`;
      slack.push(line); missing.push(line);
      continue;
    }
    const scores = average(scored.map((run) => run.scores!)), values = averageMetrics(scored.map((run) => run.metrics!)), before = previous[device];
    const count = scored.length === all.length ? `${all.length} runs` : `${scored.length} of ${all.length} runs`;
    current[device] = { sha, scores, metrics: values };
    const shown = (id: Category) => `${scores[id]}${before ? ` (${signed(scores[id] - before.scores[id])})` : ""}`;
    const shownMetric = (id: Metric) => `${formatMetric(id, values[id])}${before?.metrics ? ` (${signed(values[id] - before.metrics[id], metrics[id].digits)})` : ""}`;
    slack.push(`Lighthouse ${device} (${count}${before ? "" : ", no previous run"}): ${ids.map((id) => `${categories[id]} ${shown(id)}`).join(", ")}; ${metricIds.map((id) => `${metrics[id].label} ${shownMetric(id)}`).join(", ")}`);
    columns.push({ device, cells: [scored.length === all.length ? String(all.length) : `${scored.length} of ${all.length}`, ...ids.map(shown), ...metricIds.map(shownMetric)] });
  }
  if (Object.keys(current).length) await writeState(join(state, "lighthouse.json"), { ...previous, ...current });
  const compared = devices.flatMap((device) => current[device] && previous[device] ? [`${device} with ${shortSha(previous[device].sha)}`] : []);
  const labels = ["Runs", ...ids.map((id) => categories[id]), ...metricIds.map((id) => metrics[id].label)];
  const tableHeader = ["Lighthouse", ...columns.map(({ device }) => capitalised(device))], tableRows = columns.length ? labels.map((label, index) => [label, ...columns.map(({ cells }) => cells[index]!)]) : [];
  const averages = columns.length ? [`| ${tableHeader.join(" | ")} |\n| ${tableHeader.map(() => "---").join(" | ")} |\n${tableRows.map((row) => `| ${row.join(" | ")} |`).join("\n")}`] : [];
  const perRunLabels = [...ids.map((id) => categories[id]), ...metricIds.map((id) => metrics[id].label)];
  const perRun = results.map(({ device, page, run, scores, metrics: measured, report, error }) =>
    `| ${device} | \`${page}\` | ${run} | ${scores && measured ? `${[...ids.map((id) => scores[id]), ...metricIds.map((id) => formatMetric(id, shownUnits(id, measured[id])))].join(" | ")} | \`${relative(process.cwd(), report!)}\`` : `${perRunLabels.map(() => "-").join(" | ")} | ${error!.replaceAll("|", "\\|")}`} |`);
  const report = [
    "### Lighthouse",
    `Average scores and metrics of ${config.storefront.lighthouse.pages.map((page) => `\`${page}\``).join(", ")} per device${compared.length ? `, with the change from the ${state ? "previous audit" : "previous main run"} (${compared.join(", ")})` : ""}.`,
    ...averages,
    "Each run:",
    `| Device | Page | Run | ${perRunLabels.join(" | ")} | Report |\n| --- | --- | --- | ${perRunLabels.map(() => "---").join(" | ")} | --- |\n${perRun.join("\n")}`,
  ].join("\n\n");
  return { slack, report, missing, table: { header: tableHeader, rows: tableRows }, hasPrevious: devices.some((device) => previous[device]) };
}

const savingsTotal = (insight: Insight) => Object.values(insight.metricSavings ?? {}).reduce((sum, value) => sum + value, 0);
const mergedInsights = (scored: Run[]) => {
  const byId = new Map<string, Insight[]>();
  for (const insight of scored.flatMap((run) => run.insights ?? [])) byId.set(insight.id, [...byId.get(insight.id) ?? [], insight]);
  const merged = [...byId.values()].map((list): Insight => {
    const latest = list.at(-1)!, numeric = list.flatMap((insight) => insight.score === null ? [] : [insight.score]);
    const keys = [...new Set(list.flatMap((insight) => Object.keys(insight.metricSavings ?? {})))];
    const savings = Object.fromEntries(keys.map((key) => [key, mean(list.flatMap((insight) => insight.metricSavings?.[key] === undefined ? [] : [insight.metricSavings[key]]))]));
    return { id: latest.id, title: latest.title, score: numeric.length ? mean(numeric) : null, ...latest.displayValue ? { displayValue: latest.displayValue } : {}, ...keys.length ? { metricSavings: savings } : {}, ...latest.items ? { items: latest.items } : {}, runs: list.length };
  }).sort((a, b) => savingsTotal(b) - savingsTotal(a) || (a.score ?? 1) - (b.score ?? 1));
  const { max } = config.storefront.lighthouse.insights;
  return max ? merged.slice(0, max) : merged;
};
const grouped = (all: Run[]): LighthouseGroup => {
  const scored = all.filter((run) => run.scores && run.metrics);
  return { runs: all.length, scored: scored.length, ...scored.length ? { scores: average(scored.map((run) => run.scores!)), metrics: averageMetrics(scored.map((run) => run.metrics!)), agenticBrowsing: scored.at(-1)!.agenticBrowsing } : {}, topInsights: mergedInsights(scored) };
};
const groupedDevices = (results: Run[]) => Object.fromEntries(devices.flatMap((device) => {
  const all = results.filter((run) => run.device === device);
  return all.length ? [[device, grouped(all)]] : [];
})) as Partial<Record<Device, LighthouseGroup>>;

export function summarizeLighthouseRuns(results: Run[]): StorefrontLighthouseSummary {
  return {
    devices: groupedDevices(results),
    pages: Object.fromEntries([...new Set(results.map((run) => run.page))].map((page) => [page, groupedDevices(results.filter((run) => run.page === page))])),
    errors: results.flatMap(({ device, page, run, error }) => error ? [{ device, page, run, error }] : []),
    reports: results.flatMap((run) => run.report ? [run.report] : []),
  };
}

export const runStorefrontLighthouse = async (origin: string, directory: string, references: EventReferences, stop: AbortSignal | undefined, options: LighthouseOptions) => summarizeLighthouseRuns(await runLighthouse(origin, directory, references, stop, options));

export function compareLighthouseSummaries(before: StorefrontLighthouseSummary, after: StorefrontLighthouseSummary) {
  const delta = (from: number, to: number, digits = 0): Delta => ({ before: from, after: to, delta: Number((to - from).toFixed(digits)) });
  const compared: Partial<Record<Device, { scores: Record<Category, Delta>; metrics: Record<Metric, Delta> }>> = {}, rows: string[] = [];
  for (const device of devices) {
    const from = before.devices[device], to = after.devices[device];
    if (!from?.scores || !from.metrics || !to?.scores || !to.metrics) continue;
    const scores = Object.fromEntries(ids.map((id) => [id, delta(from.scores![id], to.scores![id])])) as Record<Category, Delta>;
    const measured = Object.fromEntries(metricIds.map((id) => [id, delta(from.metrics![id], to.metrics![id], metrics[id].digits)])) as Record<Metric, Delta>;
    compared[device] = { scores, metrics: measured };
    rows.push(...ids.map((id) => `| ${capitalised(device)} | ${categories[id]} | ${scores[id].before} | ${scores[id].after} | ${signed(scores[id].delta)} |`));
    rows.push(...metricIds.map((id) => `| ${capitalised(device)} | ${metrics[id].label} | ${formatMetric(id, measured[id].before)} | ${formatMetric(id, measured[id].after)} | ${signed(measured[id].delta, metrics[id].digits)} |`));
  }
  return { devices: compared, markdown: rows.length ? `| Device | Measure | Before | After | Change |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}` : "" };
}
