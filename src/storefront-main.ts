import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirOf } from "./agent-input.ts";
import { config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { blobBytes, gitList } from "./git.ts";
import { recordLighthouse, runLighthouse } from "./lighthouse.ts";
import { executePi } from "./pi.ts";
import type { AgentResult } from "./results.ts";
import { type Ctx, stopBefore } from "./run-context.ts";
import type { Run, Workspace } from "./schema.ts";
import { serialized } from "./single-flight.ts";
import { liveFiles, md5 } from "./storefront.ts";
import { storefrontContext } from "./storefront-site.ts";

type Change = { workspace: Workspace; headSha: string; diffBaseSha: string; diffPaths: string[]; item: NonNullable<Run["context"]>["item"] };
type Shot = { path: string; viewport: string | null; url: string };
type Baselines = Record<string, { url: string; devices: Record<string, string> }>;
type Alerts = Record<string, { title: string; sha: string }>;
type Verdict = NonNullable<AgentResult["verdict"]>;

const skill = fileURLToPath(new URL("../skills/review_storefront/SKILL.md", import.meta.url));
const state = (...parts: string[]) => resolve("data/storefront", ...parts);
const locks = new Map<string, Promise<unknown>>();
const rank: Record<Verdict, number> = { clean: 0, concerns: 1, breaking: 2 };
const shown = (path: string) => relative(process.cwd(), path);
const pageKey = (url: URL) => url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "_") || "home";

async function readJson<T>(path: string, fallback: T) {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function liveProof(repositoryPath: string, { headSha, diffPaths }: Change, stop?: AbortSignal) {
  const themePath = new RegExp(config.storefront.preview.themePaths), paths = diffPaths.filter((path) => themePath.test(path)), differing: string[] = [];
  if (!paths.length) return { paths, differing };
  const blobs = new Map((await gitList(repositoryPath, ["ls-tree", "-r", "-z", headSha, "--", ...paths])).map((entry) => {
    const tab = entry.indexOf("\t");
    return [entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]!] as const;
  }));
  const { checksums } = await liveFiles(paths, stop);
  for (const path of paths) {
    const oid = blobs.get(path), expected = oid ? md5(await blobBytes(repositoryPath, oid)) : null;
    if ((checksums.get(path) ?? null) !== expected) differing.push(path);
  }
  return { paths, differing };
}

async function sessionFiles(contextDir: string, diffPaths: string[], siteMap: string | undefined) {
  const files: Record<string, string> = { directory: contextDir };
  if (siteMap) {
    files.siteMap = join(contextDir, "site.md");
    await writeFile(files.siteMap, siteMap);
  }
  const baselines = await readJson<Baselines>(state("baselines", "index.json"), {});
  if (Object.keys(baselines).length) {
    await cp(state("baselines"), join(contextDir, "baselines"), { recursive: true });
    files.baselines = join(contextDir, "baselines.json");
    await writeJson(files.baselines, Object.fromEntries(Object.entries(baselines).map(([key, { url, devices }]) => [key, {
      url, screenshots: Object.fromEntries(Object.entries(devices).map(([device, sha]) => [device, { path: join(contextDir, "baselines", key, `${device}.png`), sha }])),
    }])));
  }
  if (diffPaths.length > config.context.inlinePaths) files.diffPaths = join(contextDir, "diff-paths.txt");
  return files;
}

async function reviewPages({ run, task, operation, stop }: Ctx, { workspace, headSha, diffBaseSha, diffPaths, item }: Change, known: Alerts) {
  const contextDir = contextDirOf(run.id), { devices, limits } = config.storefront;
  const { context: { liveUrl }, siteMap } = (await storefrontContext(task.subjectId, headSha, true))!;
  const context = JSON.stringify({
    action: task.action, item,
    storefront: {
      liveUrl, sha: headSha, previousSha: diffBaseSha, devices, confirmationRuns: limits.confirmationRuns,
      knownBreakages: Object.entries(known).map(([fingerprint, { title, sha }]) => ({ fingerprint, title, since: sha })),
    },
    ...(diffPaths.length > config.context.inlinePaths ? { diffPathCount: diffPaths.length } : { diffPaths }),
    files: await sessionFiles(contextDir, diffPaths, siteMap),
  }, null, 2);
  return executePi({
    run: { ...run, skill }, cwd: workspace.path, context, tools: ["read", "git", "browser"], scoped: { mode: "review" }, storefront: true,
    log: operation.log, contextDir, revisions: { head: headSha, base: diffBaseSha, main: headSha }, stop,
  });
}

async function updateBaselines(shots: Shot[], sha: string) {
  const { publicHost, devices } = config.storefront, index = await readJson<Baselines>(state("baselines", "index.json"), {}), taken = new Set<string>();
  for (const { path, viewport, url: raw } of shots) {
    const url = new URL(raw), key = pageKey(url);
    if (url.hostname !== publicHost || !viewport || !devices.includes(viewport) || taken.has(`${key}/${viewport}`)) continue;
    taken.add(`${key}/${viewport}`);
    await mkdir(state("baselines", key), { recursive: true });
    await copyFile(path, state("baselines", key, `${viewport}.png`));
    index[key] = { url: url.origin + url.pathname, devices: { ...index[key]?.devices, [viewport]: sha } };
  }
  await writeJson(state("baselines", "index.json"), index);
  return taken.size;
}

export function reviewStorefront(ctx: Ctx, change: Change, result: AgentResult): Promise<AgentResult> {
  const { run, repositoryPath, references, operation, stop } = ctx, { headSha: sha } = change, short = sha.slice(0, 7);
  const settled = <T>(part: string, work: Promise<T>) => work.then((value) => ({ value }), (error: unknown) => {
    stopBefore(stop, "publication");
    operation.log.warn({ event: "storefront.review_failed", part, sha, err: error });
    return { error: errorMessage(error).replace(/\s+/g, " ") };
  });
  return serialized(locks, "storefront", async () => {
    try {
      const proof = await liveProof(repositoryPath, change, stop);
      if (proof.differing.length) {
        return { ...result, storefront: { slack: `*Storefront*: the live theme does not match ${short} yet (${proof.differing.length} of ${proof.paths.length} changed theme files differ), so the visual review and Lighthouse were skipped.` } };
      }
      const known = await readJson<Alerts>(state("alerts.json"), {}), contextDir = contextDirOf(run.id);
      const pages = await settled("pages", reviewPages(ctx, change, known));
      const lighthouse = await settled("lighthouse", runLighthouse(`https://${config.storefront.publicHost}/`, join(contextDir, "lighthouse"), references, stop));
      const review = "value" in pages && pages.value.outcome === "complete" ? pages.value : undefined;
      const breakages = (review?.issues ?? []).map((issue) => ({ ...issue, since: known[issue.fingerprint]?.sha }));
      const fresh = breakages.filter((breakage) => !breakage.since), broken = breakages.length > 0 || review?.verdict === "breaking";
      const shots = (await readFile(join(contextDir, "screenshots.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Shot);
      const updated = review && !broken ? await updateBaselines(shots, sha) : undefined;
      if (review) await writeJson(state("alerts.json"), Object.fromEntries(breakages.map(({ fingerprint, title, since }) => [fingerprint, { title, sha: since ?? sha }])));
      const measured = "value" in lighthouse ? await recordLighthouse(lighthouse.value, sha)
        : { slack: [`Lighthouse: not run (${lighthouse.error})`], report: `### Lighthouse\n\nNot run: ${lighthouse.error}` };
      const [headline = "", ...rest] = review?.text.trim().split("\n") ?? [], end = rest.findIndex((line) => !line.startsWith("• "));
      const failure = "error" in pages ? `failed (${pages.error})` : review ? undefined : `returned ${pages.value.outcome}`;
      const slack = [
        `*Storefront* on ${short}: ${failure ? `the visual review ${failure}` : headline}`,
        ...end < 0 ? rest : rest.slice(0, end),
        ...breakages.map(({ title, fingerprint, since }) => since ? `• Still broken since ${since.slice(0, 7)} \`${fingerprint}\`: ${title}` : `• New breakage \`${fingerprint}\`: ${title}`),
        ...measured.slack.map((line) => `• ${line}`),
      ].join("\n");
      const report = [
        `## Storefront review of ${sha}`,
        proof.paths.length ? `The live \`MAIN\` theme matches this commit for the ${proof.paths.length} theme file(s) the change touches.` : "The change touches no theme files; the live store was reviewed as it is.",
        review?.text.trim() ?? `The visual review ${failure}.`,
        ...breakages.length ? [`### Confirmed breakage\n\n${breakages.map(({ title, fingerprint, body, since }) => `- **${title}** (\`${fingerprint}\`, ${since ? `first reported on ${since}` : "new on this commit"})\n\n${body.replace(/^/gm, "  ")}`).join("\n\n")}`] : [],
        measured.report,
        [
          `### Screenshots\n\n${shots.length} screenshot(s) under \`${shown(contextDir)}\`${shots.length ? ":" : "."}`,
          ...shots.map(({ path, viewport, url }) => `- \`${url}\` at ${viewport ?? "the current viewport"}: \`${shown(path)}\``),
          "",
          updated !== undefined ? `${updated} baseline screenshot(s) updated under \`${shown(state("baselines"))}\`.`
            : `The baselines under \`${shown(state("baselines"))}\` were kept, because ${review ? "this run found a breakage" : "the visual review did not complete"}.`,
        ].join("\n"),
      ].join("\n\n");
      const storefrontVerdict: Verdict | undefined = !review ? undefined : fresh.length ? "breaking" : breakages.length && review.verdict === "breaking" ? "concerns" : review.verdict;
      const verdict = result.verdict && storefrontVerdict && rank[storefrontVerdict] > rank[result.verdict] ? storefrontVerdict : result.verdict;
      return { ...result, verdict, storefront: { slack, report } };
    } catch (error) {
      stopBefore(stop, "publication");
      operation.log.warn({ event: "storefront.review_failed", sha, err: error });
      return { ...result, storefront: { slack: `*Storefront*: not checked (${errorMessage(error).replace(/\s+/g, " ")}).` } };
    }
  });
}
