import { writeFile } from "node:fs/promises";

type Input = { url: string; device: string; reportPath: string; flags: Record<string, unknown>; categories: Record<string, string>; metrics: Record<string, string> };
type Audit = (url: string, flags: Record<string, unknown>, settings?: unknown) => Promise<{ lhr: { categories: Record<string, { score: number | null } | undefined>; audits?: Record<string, { numericValue?: unknown } | undefined> }; report: string | string[] } | undefined>;

try {
  const { url, device, reportPath, flags, categories, metrics } = JSON.parse(process.argv[2]!) as Input;
  const specifier = "lighthouse", { default: audit, desktopConfig } = await import(specifier) as { default: Audit; desktopConfig: unknown };
  const result = await audit(url, flags, device === "desktop" ? desktopConfig : undefined);
  if (!result) throw new Error("Lighthouse returned no result");
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
  await writeFile(reportPath, Array.isArray(result.report) ? result.report[0]! : result.report);
  process.stdout.write(JSON.stringify({ scores, metrics: measured }), () => process.exit(0));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error), () => process.exit(1));
}
