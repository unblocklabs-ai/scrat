import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { withValidationSlot } from "./commands.ts";
import { config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { launchChromium } from "./scoped-tools.ts";

const categories = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best Practices", seo: "SEO" } as const;
const devices = ["mobile", "desktop"] as const;
type Category = keyof typeof categories;
type Device = typeof devices[number];
type Scores = Record<Category, number>;
type Run = { device: Device; page: string; run: number; scores?: Scores; report?: string; error?: string };
type Previous = Partial<Record<Device, { sha: string; scores: Scores }>>;
type Audit = (url: string, flags: Record<string, unknown>, settings?: unknown) => Promise<{ lhr: { categories: Record<string, { score: number | null } | undefined> }; report: string | string[] } | undefined>;
type Lighthouse = { default: Audit; desktopConfig: unknown };

const ids = Object.keys(categories) as Category[];
const previousFile = () => resolve("data/storefront/lighthouse.json");

export async function loadLighthouse() {
  const specifier = "lighthouse";
  return await import(specifier).catch((error: unknown) => {
    throw new Error("Storefront Lighthouse runs need the optional lighthouse package, which is not installed (see the README storefront section)", { cause: error });
  }) as Lighthouse;
}

const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => done(port));
  });
});

async function audited({ audit, desktopConfig }: { audit: Audit; desktopConfig: unknown }, url: string, device: Device, signal: AbortSignal) {
  const port = await freePort(), browser = await launchChromium([`--remote-debugging-port=${port}`]);
  const abort = () => void browser.close().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await audit(url, { port, output: "json", logLevel: "error", onlyCategories: ids }, device === "desktop" ? desktopConfig : undefined);
    if (!result) throw new Error("Lighthouse returned no result");
    const scores = Object.fromEntries(ids.map((id) => {
      const score = result.lhr.categories[id]?.score;
      if (typeof score !== "number") throw new Error(`Lighthouse returned no ${categories[id]} score`);
      return [id, Math.round(score * 100)];
    })) as Scores;
    return { scores, report: Array.isArray(result.report) ? result.report[0]! : result.report };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
}

export async function runLighthouse(origin: string, directory: string, references: EventReferences, stop?: AbortSignal) {
  const { runs, pages, timeoutSeconds } = config.storefront.lighthouse;
  const { default: audit, desktopConfig } = await loadLighthouse();
  await mkdir(directory, { recursive: true });
  return withValidationSlot(async () => {
    const budget = AbortSignal.timeout(timeoutSeconds * 1000), signal = stop ? AbortSignal.any([budget, stop]) : budget, results: Run[] = [];
    for (const device of devices) for (const [index, page] of pages.entries()) for (let run = 1; run <= runs; run++) {
      if (stop?.aborted) throw stop.reason;
      if (budget.aborted) { results.push({ device, page, run, error: `not run, the ${timeoutSeconds}s budget was spent` }); continue; }
      try {
        const { scores, report } = await audited({ audit, desktopConfig }, new URL(page, origin).href, device, signal);
        const path = join(directory, `${device}-${index + 1}-${run}.json`);
        await writeFile(path, report);
        results.push({ device, page, run, scores, report: path });
      } catch (error) {
        if (stop?.aborted) throw error;
        results.push({ device, page, run, error: budget.aborted ? `stopped when the ${timeoutSeconds}s budget was spent` : errorMessage(error).replace(/\s+/g, " ") });
      }
    }
    return results;
  }, references, stop);
}

const average = (scored: Scores[]) => Object.fromEntries(ids.map((id) => [id, Math.round(scored.reduce((sum, scores) => sum + scores[id], 0) / scored.length)])) as Scores;
const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? String(value) : "±0";

export async function recordLighthouse(results: Run[], sha: string) {
  const previous = JSON.parse(await readFile(previousFile(), "utf8").catch(() => "{}")) as Previous, current: Previous = {};
  const slack: string[] = [], table: string[] = [];
  for (const device of devices) {
    const all = results.filter((run) => run.device === device), scored = all.flatMap((run) => run.scores ? [run.scores] : []);
    if (!all.length) continue;
    if (!scored.length) {
      slack.push(`Lighthouse ${device}: no result (${all[0]!.error})`);
      table.push(`| ${device} | 0 of ${all.length} | ${ids.map(() => "-").join(" | ")} |`);
      continue;
    }
    const scores = average(scored), before = previous[device], count = scored.length === all.length ? `${all.length} runs` : `${scored.length} of ${all.length} runs`;
    current[device] = { sha, scores };
    const shown = (id: Category) => `${scores[id]}${before ? ` (${signed(scores[id] - before.scores[id])})` : ""}`;
    slack.push(`Lighthouse ${device} (${count}${before ? "" : ", no previous run"}): ${ids.map((id) => `${categories[id]} ${shown(id)}`).join(", ")}`);
    table.push(`| ${device} | ${scored.length} of ${all.length} | ${ids.map(shown).join(" | ")} |`);
  }
  if (Object.keys(current).length) {
    await mkdir(resolve("data/storefront"), { recursive: true });
    await writeFile(previousFile(), JSON.stringify({ ...previous, ...current }, null, 2) + "\n");
  }
  const compared = devices.flatMap((device) => current[device] && previous[device] ? [`${device} with ${previous[device].sha.slice(0, 7)}`] : []);
  const header = `| Device | Runs | ${ids.map((id) => categories[id]).join(" | ")} |\n| --- | --- | ${ids.map(() => "---").join(" | ")} |`;
  const perRun = results.map(({ device, page, run, scores, report, error }) =>
    `| ${device} | \`${page}\` | ${run} | ${scores ? `${ids.map((id) => scores[id]).join(" | ")} | \`${relative(process.cwd(), report!)}\`` : `${ids.map(() => "-").join(" | ")} | ${error!.replaceAll("|", "\\|")}`} |`);
  const report = [
    "### Lighthouse",
    `Average scores of ${config.storefront.lighthouse.pages.map((page) => `\`${page}\``).join(", ")} per device${compared.length ? `, with the change from the previous main run (${compared.join(", ")})` : ""}.`,
    `${header}\n${table.join("\n")}`,
    "Each run:",
    `| Device | Page | Run | ${ids.map((id) => categories[id]).join(" | ")} | Report |\n| --- | --- | --- | ${ids.map(() => "---").join(" | ")} | --- |\n${perRun.join("\n")}`,
  ].join("\n\n");
  return { slack, report };
}
