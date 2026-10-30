import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirOf, contextFiles } from "./agent-input.ts";
import { inferenceRunOf } from "./run-history.ts";
import { commitInput, postReply } from "./commit-review.ts";
import { config } from "./config.ts";
import type { EffectContext } from "./effects.ts";
import { errorMessage } from "./errors.ts";
import { blobBytes, shortSha } from "./git.ts";
import { recordLighthouse, runLighthouse } from "./lighthouse.ts";
import { bestEffort, logger } from "./logging.ts";
import { storefrontMarker } from "./markers.ts";
import { executePi } from "./pi.ts";
import type { AgentResult } from "./results.ts";
import { type Ctx, stopBefore } from "./run-context.ts";
import type { Run, Workspace } from "./schema.ts";
import { serialized } from "./single-flight.ts";
import { escapeSlack } from "./slack.ts";
import { linkSection, reviewBlocks, tableBlock } from "./slack-blocks.ts";
import { liveFiles, md5, readState, statePath, treeBlobs, writeState, writeStateText } from "./storefront.ts";
import { type Alerts, type Baselines, auditState, knownBreakages, stageBaselines, storefrontContext } from "./storefront-site.ts";
import { parseTriggerInput } from "./triggers.ts";

type Change = { workspace: Workspace; headSha: string; diffBaseSha: string; diffPaths: string[]; item: NonNullable<Run["context"]>["item"] };
type Shot = { path: string; viewport: string | null; url: string };
type Pages = { value: AgentResult } | { error: string };
type Verdict = NonNullable<AgentResult["verdict"]>;
type Storefront = NonNullable<AgentResult["storefrontReview"]>;

const skill = fileURLToPath(new URL("../skills/review_storefront/SKILL.md", import.meta.url));
const locks = new Map<string, Promise<unknown>>();
const rank: Record<Verdict, number> = { clean: 0, concerns: 1, breaking: 2 };
const shown = (path: string) => relative(process.cwd(), path);
const pageKey = (url: URL) => url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "_") || "home";

async function liveProof({ repositoryPath, operation, stop }: Ctx, { headSha, diffPaths }: Change) {
  const themePath = new RegExp(config.storefront.preview.themePaths), paths = diffPaths.filter((path) => themePath.test(path)), differing: string[] = [];
  if (!paths.length) return { paths, differing };
  const blobs = await treeBlobs(repositoryPath, headSha, paths), live = await liveFiles(paths, stop);
  for (const path of paths) {
    const oid = blobs.get(path), expected = oid ? md5(await blobBytes(repositoryPath, oid)) : null;
    const matches = !live.checksums.has(path) ? expected === null
      : expected !== null && (live.checksums.get(path) === expected || md5(await live.bytes(path)) === expected);
    if (!matches) differing.push(path);
  }
  if (differing.length) operation.log.warn({ event: "storefront.live_mismatch", sha: headSha, paths: differing });
  return { paths, differing };
}

async function sessionFiles(contextDir: string, diffPaths: string[], siteMap: string | undefined) {
  const { files, write, spill } = await contextFiles(contextDir);
  if (siteMap) await write("siteMap", "site.md", siteMap);
  const diffPathCount = await spill("diffPaths", "diff-paths.txt", diffPaths);
  await stageBaselines(contextDir, write, "");
  return { files, diffPathCount };
}

async function reviewPages({ run, task, operation, stop }: Ctx, { workspace, headSha, diffBaseSha, diffPaths, item }: Change, known: Alerts | undefined, record: (session: Storefront["session"]) => void) {
  const contextDir = contextDirOf(run.id), { devices, limits } = config.storefront;
  const { context: { liveUrl }, siteMap } = (await storefrontContext(task.subjectId, headSha, "storefront"))!;
  const { files, diffPathCount } = await sessionFiles(contextDir, diffPaths, siteMap);
  const context = JSON.stringify({
    action: task.action, item,
    storefront: { liveUrl, sha: headSha, previousSha: diffBaseSha, devices, confirmationRuns: limits.confirmationRuns, knownBreakages: knownBreakages(known) },
    ...(diffPathCount ? { diffPathCount } : { diffPaths }),
    files,
  }, null, 2);
  return executePi({
    run: { ...run, skill, ...config.storefront.model }, cwd: workspace.path, tools: ["read", "grep", "find", "ls", "git", "browser"],
    scoped: { mode: "review", browser: { navigationHosts: "any", resourceHosts: "any", limits: { steps: limits.browserSteps, milliseconds: limits.browserSeconds * 1000 } } },
    log: operation.log, contextDir, revisions: { head: headSha, base: diffBaseSha, main: headSha }, stop,
  }, { context, onSession: record });
}

async function replaceBaselines(shots: Shot[], sha: string, state: string) {
  const { publicHost, devices } = config.storefront, next = statePath(state, "baselines.next"), index: Baselines = {};
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  for (const { path, viewport, url: raw } of shots) {
    const url = new URL(raw), key = pageKey(url);
    if (url.host !== publicHost || !viewport || !devices.includes(viewport) || index[key]?.devices[viewport]) continue;
    await mkdir(join(next, key), { recursive: true });
    await copyFile(path, join(next, key, `${viewport}.png`));
    index[key] = { url: url.origin + url.pathname, devices: { ...index[key]?.devices, [viewport]: sha } };
  }
  await writeFile(join(next, "index.json"), JSON.stringify(index, null, 2) + "\n");
  await rm(statePath(state, "baselines"), { recursive: true, force: true });
  await rename(next, statePath(state, "baselines"));
  return Object.values(index).reduce((count, { devices: taken }) => count + Object.keys(taken).length, 0);
}

const settled = <T>({ operation, stop }: Ctx, sha: string, part: string, work: Promise<T>) => work.then((value) => ({ value }), (error: unknown) => {
  stopBefore(stop, "publication");
  operation.log.warn({ event: "storefront.review_failed", part, sha, err: error });
  return { error: errorMessage(error).replace(/\s+/g, " ") };
});

async function finishStorefront(ctx: Ctx, { sha, state, known, pages, session, title, intro, shotsDir }: {
  sha: string; state: string; known: Alerts | undefined; pages: Pages; session?: Storefront["session"]; title?: string; intro: string[]; shotsDir: string;
}) {
  const { run, references, stop } = ctx, contextDir = contextDirOf(run.id);
  const lighthouse = await settled(ctx, sha, "lighthouse", runLighthouse(`https://${config.storefront.publicHost}/`, join(contextDir, "lighthouse"), references, stop));
  const review = "value" in pages && pages.value.outcome === "complete" ? pages.value : undefined;
  const breakages = (review?.issues ?? []).map((issue) => ({ ...issue, since: known ? known[issue.fingerprint]?.sha : "" }));
  const fresh = breakages.filter((breakage) => breakage.since === undefined);
  const storefrontVerdict: Verdict | undefined = !review ? undefined : fresh.length ? "breaking" : review.verdict === "breaking" ? "concerns" : review.verdict;
  const shots = (await readFile(join(shotsDir, "screenshots.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Shot);
  const replaced = storefrontVerdict === "clean" ? await replaceBaselines(shots, sha, state) : undefined;
  if (review) await writeState(join(state, "alerts.json"), Object.fromEntries(breakages.map(({ fingerprint, title, since }) => [fingerprint, { title, sha: since || sha }])));
  const measured = "value" in lighthouse ? await recordLighthouse(lighthouse.value, sha, state)
    : { slack: [`Lighthouse: not run (${lighthouse.error})`], report: `### Lighthouse\n\nNot run: ${lighthouse.error}` };
  const [headline = "", ...rest] = review?.text.trim().split("\n") ?? [], end = rest.findIndex((line) => !line.startsWith("• "));
  const failure = "error" in pages ? `failed (${pages.error})` : review ? undefined : `returned ${pages.value.outcome}`;
  const lines = [
    ...title === undefined ? [] : [`*Storefront* on ${title}: ${failure ? `the visual review ${failure}` : headline}`],
    ...end < 0 ? rest : rest.slice(0, end),
    ...breakages.map(({ title, fingerprint, since }) => since === undefined ? `• New breakage \`${fingerprint}\`: ${title}` : `• Still broken${since ? ` since ${shortSha(since)}` : ""} \`${fingerprint}\`: ${title}`),
  ], bullets = measured.slack.map((line) => `• ${line}`), table = "table" in measured && measured.table.rows.length ? measured.table : undefined;
  const slack = [...lines, ...bullets].join("\n"), shownText = [...lines, ...("missing" in measured && table ? measured.missing.map((line) => `• ${line}`) : bullets)].join("\n");
  const blocks = [
    ...shownText ? reviewBlocks(shownText) : [],
    ...table ? [tableBlock(table.header, table.rows, { align: table.header.map((_, index) => index ? "right" as const : "left" as const) })] : [],
    ...table && "hasPrevious" in measured && !measured.hasPrevious ? [{ type: "context", elements: [{ type: "mrkdwn", text: "No previous Lighthouse run to compare against." }] }] : [],
  ];
  const reported = (since: string | undefined) => since === undefined ? "new on this commit" : since ? `first reported on ${since}` : "reported earlier; the earlier record could not be read";
  const report = [
    ...intro,
    review?.text.trim() ?? `The visual review ${failure}.`,
    ...breakages.length ? [`### Confirmed breakage\n\n${breakages.map(({ title, fingerprint, body, since }) => `- **${title}** (\`${fingerprint}\`, ${reported(since)})\n\n${body.replace(/^/gm, "  ")}`).join("\n\n")}`] : [],
    measured.report,
    [
      `### Screenshots\n\n${shots.length} screenshot(s) under \`${shown(contextDir)}\`${shots.length ? ":" : "."}`,
      ...shots.map(({ path, viewport, url }) => `- \`${url}\` at ${viewport ?? "the current viewport"}: \`${shown(path)}\``),
      "",
      replaced !== undefined ? `The baselines under \`${shown(statePath(state, "baselines"))}\` are now this run's ${replaced} screenshot(s).`
        : `The baselines under \`${shown(statePath(state, "baselines"))}\` were kept, because ${review ? `the storefront verdict is ${storefrontVerdict ?? "missing"}` : "the visual review did not complete"}.`,
    ].join("\n"),
  ].join("\n\n");
  return { storefrontVerdict, storefrontReview: { slack, blocks, report, session } };
}

export function reviewStorefront(ctx: Ctx, change: Change, result: AgentResult): Promise<AgentResult> {
  const { operation, stop } = ctx, { headSha: sha } = change, short = shortSha(sha);
  return serialized(locks, "storefront", async () => {
    let session: Storefront["session"];
    try {
      const proof = await liveProof(ctx, change);
      if (proof.differing.length) {
        return { ...result, storefrontReview: { slack: `*Storefront*: the live theme does not match ${short} yet (${proof.differing.length} of ${proof.paths.length} changed theme files differ), so the visual review and Lighthouse were skipped.` } };
      }
      const known = await readState<Alerts>("alerts.json", {});
      const pages = await settled(ctx, sha, "pages", reviewPages(ctx, change, known, (details) => { session = details; }));
      const { storefrontVerdict, storefrontReview } = await finishStorefront(ctx, {
        sha, state: "", known, pages, session, title: short, shotsDir: contextDirOf(ctx.run.id),
        intro: [`## Storefront review of ${sha}`, proof.paths.length ? `The live \`MAIN\` theme matches this commit for the ${proof.paths.length} theme file(s) the change touches.` : "The change touches no theme files; the live store was reviewed as it is."],
      });
      const verdict = result.verdict && storefrontVerdict && rank[storefrontVerdict] > rank[result.verdict] ? storefrontVerdict : result.verdict;
      return { ...result, verdict, storefrontReview };
    } catch (error) {
      stopBefore(stop, "publication");
      operation.log.warn({ event: "storefront.review_failed", sha, err: error });
      return { ...result, storefrontReview: { slack: `*Storefront*: not checked (${errorMessage(error).replace(/\s+/g, " ")}).`, session } };
    }
  });
}

export function auditStorefront(ctx: Ctx, sha: string, result: AgentResult): Promise<AgentResult> {
  const { operation, stop } = ctx, tick = parseTriggerInput(ctx.run.input);
  return serialized(locks, "storefront", async () => {
    try {
      const known = await readState<Alerts>(join(auditState, "alerts.json"), {});
      const { storefrontVerdict, storefrontReview } = await finishStorefront(ctx, {
        sha, state: auditState, known, pages: { value: result }, shotsDir: contextDirOf(inferenceRunOf(ctx.run).id),
        intro: [`## Store audit of ${tick.kind === "tick" ? tick.end : sha}`, `Lighthouse and the screenshots belong to \`${config.github.baseBranch}\` at ${sha}.`],
      });
      return { ...result, verdict: storefrontVerdict ?? result.verdict, storefrontReview };
    } catch (error) {
      stopBefore(stop, "publication");
      operation.log.warn({ event: "storefront.review_failed", sha, err: error });
      return { ...result, storefrontReview: { slack: `Lighthouse and the baselines could not be recorded (${errorMessage(error).replace(/\s+/g, " ")}).` } };
    }
  });
}

export async function publishStorefront({ github, subject, task, run, references, publication, saveReceipt }: EffectContext) {
  const { slack, blocks, report } = run.result.storefrontReview!;
  if (report && !publication().storefrontReportUrl) {
    const url = await bestEffort(logger, "storefront.report_failed", references, () => github.upsertCommitComment(commitInput(run.input).sha, report, storefrontMarker, references));
    if (url) saveReceipt({ storefrontReportUrl: url });
  }
  const url = publication().storefrontReportUrl;
  saveReceipt({ storefrontReplyTs: await postReply(subject, task.action, run, escapeSlack(slack) + (url ? `\n<${url}|Full storefront report>` : ""), url && blocks ? [...blocks, linkSection(url, "Full storefront report")] : blocks) });
}

export async function publishAudit({ subject, task, run, saveReceipt }: EffectContext) {
  const { slack, blocks, report } = run.result.storefrontReview!, tick = parseTriggerInput(run.input);
  if (report && tick.kind === "tick") await writeStateText(join(auditState, `${tick.end}.md`), report);
  const ts = await postReply(subject, task.action, run, escapeSlack(slack), blocks);
  saveReceipt({ slackReplyTs: ts, storefrontReplyTs: ts });
}
