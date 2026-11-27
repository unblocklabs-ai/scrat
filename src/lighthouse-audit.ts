import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type Input = { url: string; device: string; reportPath: string; flags: Record<string, unknown>; categories: Record<string, string>; metrics: Record<string, string>; insightIds: string[]; agentic: boolean; maxInsights: number; maxItems: number; valueChars: number };
type Detail = { type?: string; items?: unknown; selector?: unknown; nodeLabel?: unknown; snippet?: unknown; value?: unknown; url?: unknown };
type LhAudit = { numericValue?: unknown; title?: string; score?: number | null; scoreDisplayMode?: string; displayValue?: string; metricSavings?: Record<string, unknown>; details?: Detail };
type Lhr = { categories: Record<string, { score: number | null; auditRefs?: { id: string; group?: string }[] } | undefined>; audits?: Record<string, LhAudit | undefined>; finalDisplayedUrl?: string; mainDocumentUrl?: string };
type PageHandle = { url(): string; evaluate(expression: string): Promise<unknown>; close(): Promise<void> };
type Connect = (options: { browserURL: string; defaultViewport: null }) => Promise<{ newPage(): Promise<PageHandle>; disconnect(): Promise<void> }>;
type Audit = (url: string, flags: Record<string, unknown>, settings: unknown, page: PageHandle) => Promise<{ lhr: Lhr; report: string | string[] } | undefined>;

const skipped = new Set(["notApplicable", "manual", "error"]);
const agenticSkipped = new Set(["notApplicable", "manual", "informative"]);
const limited = <T>(values: T[], max: number) => max ? values.slice(0, max) : values;
const text = (value: unknown) => typeof value === "string" ? value : undefined;

const compactValue = (value: unknown, valueChars: number): string | number | boolean | undefined => {
  if (typeof value === "string") return value.slice(0, valueChars);
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { type, selector, nodeLabel, snippet, value: inner, url } = value as Detail;
  const shown = type === "node" ? text(selector) ?? text(nodeLabel) ?? text(snippet) : type === "url" ? text(inner) : type === "source-location" ? text(url) : undefined;
  return shown?.slice(0, valueChars);
};

const rowsOf = (detail: Detail | undefined): unknown[] => detail?.type === "checklist" ? Object.entries(detail.items as Record<string, { value?: unknown; label?: unknown }>).map(([id, { value, label }]) => ({ id, label, value })) : Array.isArray(detail?.items) ? detail.items : [];

const compactItems = (details: Detail | undefined, maxItems: number, valueChars: number) => {
  try {
    const items = details?.type === "list" ? (details.items as Detail[]).flatMap((part) => rowsOf(part.type === "list-section" ? part.value as Detail : part)) : rowsOf(details);
    const compact = limited(items, maxItems).flatMap((item) => item && typeof item === "object" ? [Object.fromEntries(Object.entries(item as Record<string, unknown>).flatMap(([key, value]) => {
      const shown = compactValue(value, valueChars);
      return shown === undefined ? [] : [[key, shown]];
    }))] : []);
    return compact.length ? compact : undefined;
  } catch {
    return undefined;
  }
};

const savingsOf = (audit: LhAudit) => Object.fromEntries(Object.entries(audit.metricSavings ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] !== 0));
const total = (savings: Record<string, number>) => Object.values(savings).reduce((sum, value) => sum + value, 0);

try {
  const { url, device, reportPath, flags, categories, metrics, insightIds, agentic, maxInsights, maxItems, valueChars } = JSON.parse(process.argv[2]!) as Input;
  const specifier = "lighthouse", { default: audit, desktopConfig } = await import(specifier) as { default: Audit; desktopConfig: unknown };
  const browserApi = await import(pathToFileURL(createRequire(fileURLToPath(import.meta.resolve(specifier))).resolve("puppeteer-core")).href) as { connect?: Connect; default?: { connect: Connect } };
  const browser = await (browserApi.connect ?? browserApi.default!.connect)({ browserURL: `http://127.0.0.1:${flags.port}`, defaultViewport: null }), page = await browser.newPage();
  let result, served;
  try {
    result = await audit(url, flags, device === "desktop" ? desktopConfig : undefined, page);
    if (!result) throw new Error("Lighthouse returned no result");
    served = { url: page.url(), finalDisplayedUrl: result.lhr.finalDisplayedUrl, mainDocumentUrl: result.lhr.mainDocumentUrl, themeId: await page.evaluate("window.Shopify?.theme?.id") };
  } finally {
    await page.close().catch(() => undefined);
    await browser.disconnect().catch(() => undefined);
  }
  const scores = Object.fromEntries(Object.entries(categories).map(([id, label]) => {
    const score = result.lhr.categories[id]?.score;
    if (typeof score !== "number") throw new Error(`Lighthouse returned no ${label} score`);
    return [id, Math.round(score * 100)];
  }));
  const measured = Object.fromEntries(Object.entries(metrics).map(([id, label]) => {
    const value = result.lhr.audits?.[id]?.numericValue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Lighthouse returned no ${label} value`);
    return [id, value];
  }));
  const flagged = insightIds.flatMap((id) => {
    const found = result.lhr.audits?.[id];
    if (!found || skipped.has(found.scoreDisplayMode ?? "")) return [];
    const savings = savingsOf(found), score = typeof found.score === "number" ? found.score : null;
    if (!(score !== null ? score < 1 : Object.keys(savings).length)) return [];
    const items = compactItems(found.details, maxItems, valueChars);
    return [{ id, title: found.title ?? id, score, savings, ...found.displayValue ? { displayValue: found.displayValue } : {}, ...items ? { items } : {} }];
  }).sort((a, b) => total(b.savings) - total(a.savings) || (a.score ?? 1) - (b.score ?? 1));
  const insights = limited(flagged, maxInsights).map(({ savings, ...insight }) => ({ ...insight, ...Object.keys(savings).length ? { metricSavings: savings } : {} }));
  const category = agentic ? result.lhr.categories["agentic-browsing"] : undefined;
  const refs = (category?.auditRefs ?? []).flatMap(({ id, group }) => {
    const found = result.lhr.audits?.[id];
    return found && group !== "hidden" && !agenticSkipped.has(found.scoreDisplayMode ?? "") ? [{ id, found }] : [];
  });
  const passes = (found: LhAudit) => found.scoreDisplayMode !== "error" && typeof found.score === "number" && found.score >= 0.9;
  const agenticBrowsing = category ? {
    passed: refs.filter(({ found }) => passes(found)).length, total: refs.length,
    failed: refs.filter(({ found }) => !passes(found)).map(({ id, found }) => ({ id, title: found.title ?? id, ...found.displayValue ? { displayValue: found.displayValue } : {} })),
  } : undefined;
  await writeFile(reportPath, Array.isArray(result.report) ? result.report[0]! : result.report);
  process.stdout.write(JSON.stringify({ scores, metrics: measured, insights, agenticBrowsing, served }), () => process.exit(0));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error), () => process.exit(1));
}
