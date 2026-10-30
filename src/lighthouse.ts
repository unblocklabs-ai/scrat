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
import { launchChromium } from "./scoped-tools.ts";
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
type Run = { device: Device; page: string; run: number; scores?: Scores; metrics?: Metrics; report?: string; error?: string };
type Previous = Partial<Record<Device, { sha: string; scores: Scores; metrics?: Metrics }>>;

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

const childAudit = (input: string, signal: AbortSignal) => new Promise<{ scores: Scores; metrics: Metrics }>((done, fail) => {
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

async function audited(url: string, device: Device, reportPath: string, signal: AbortSignal) {
  const port = await freePort(), browser = await launchChromium([`--remote-debugging-port=${port}`]);
  try {
    const flags = { port, output: "json", logLevel: "error", onlyCategories: ids, disableFullPageScreenshot: true };
    return await childAudit(JSON.stringify({ url, device, reportPath, flags, categories, metrics: labelled(metrics) }), signal);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function runLighthouse(origin: string, directory: string, references: EventReferences, stop?: AbortSignal) {
  const { runs, pages, timeoutSeconds } = config.storefront.lighthouse;
  await loadLighthouse();
  await mkdir(directory, { recursive: true });
  return withValidationSlot(async () => {
    const budget = AbortSignal.timeout(timeoutSeconds * 1000), signal = stop ? AbortSignal.any([budget, stop]) : budget, results: Run[] = [];
    for (const device of devices) for (const [index, page] of pages.entries()) for (let run = 1; run <= runs; run++) {
      if (stop?.aborted) throw stop.reason;
      if (budget.aborted) { results.push({ device, page, run, error: `not run, the ${timeoutSeconds}s budget was spent` }); continue; }
      try {
        const path = join(directory, `${device}-${index + 1}-${run}.json`);
        const { scores, metrics } = await audited(new URL(page, origin).href, device, path, signal);
        results.push({ device, page, run, scores, metrics, report: path });
      } catch (error) {
        if (stop?.aborted) throw error;
        results.push({ device, page, run, error: budget.aborted ? `stopped when the ${timeoutSeconds}s budget was spent` : errorMessage(error).replace(/\s+/g, " ") });
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
