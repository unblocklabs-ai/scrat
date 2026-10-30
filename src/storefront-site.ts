import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config, getRepositoryPath, isActionEnabled } from "./config.ts";
import { ifMissing } from "./errors.ts";
import { commitOf, gitList } from "./git.ts";
import { botName } from "./identity.ts";
import { upsertSubject } from "./items.ts";
import type { Evaluated } from "./effects.ts";
import { latestRunOfTask } from "./run-history.ts";
import type { Subject, Task } from "./schema.ts";
import { pollSource, sourceCursor } from "./sources.ts";
import { previewContext, readState, statePath, writeStateText } from "./storefront.ts";
import { enqueueTask, latestTask } from "./tasks.ts";
import type { TriggerInput } from "./triggers.ts";

export type Baselines = Record<string, { url: string; devices: Record<string, string> }>;
export type Alerts = Record<string, { title: string; sha: string }>;

export const auditState = "audits";
const scope = "site_map", dayMs = 86_400_000, hourMs = 3_600_000;
const siteMapPath = () => statePath("site.md");
const liveUrl = () => `https://${config.storefront.publicHost}/`;
const skillHash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

async function structureChange(mapped: string | undefined) {
  const path = getRepositoryPath(), branch = config.github.baseBranch, tip = await commitOf(path, `refs/remotes/origin/${branch}`);
  if (!mapped || !tip || tip === mapped) return undefined;
  const pattern = new RegExp(config.storefront.siteMapPaths), changes = await gitList(path, ["diff", "--name-status", "--no-renames", "--diff-filter=AD", "-z", mapped, tip]);
  const index = changes.findIndex((entry, at) => at % 2 === 1 && pattern.test(entry));
  return index < 0 ? undefined : `${changes[index]} was ${changes[index - 1] === "A" ? "added" : "deleted"} on ${branch} between ${mapped.slice(0, 7)} and ${tip.slice(0, 7)}`;
}

export function pollSiteMap(repository = config.github.repository, now = new Date()) {
  return pollSource("site_map.poll", "storefront", repository, async ({ name: action, skill: skillPath }) => {
    if (!isActionEnabled(action)) return 0;
    const [written, skill, mapped] = sourceCursor(repository, action, scope).value?.split(" ") ?? [];
    const due = !written ? "the store has no site map yet"
      : !existsSync(siteMapPath()) || now.getTime() - Date.parse(written) >= config.storefront.siteMapMaxAgeDays * dayMs ? `the site map written ${written} is due`
      : skill !== await skillHash(skillPath) ? `the discovery skill changed after the site map written ${written}`
      : await structureChange(mapped);
    if (!due) return 0;
    const end = now.toISOString(), hours = config.storefront.siteMapRetryHours;
    const subject = upsertSubject({ repository, kind: "window", key: `${action}:${written ?? "none"}`, metadata: { start: written ?? end, end } });
    const latest = latestTask(subject.id, action), run = latest && latestRunOfTask(latest.id);
    if (latest && (latest.status === "queued" || latest.status === "running" || now.getTime() - Date.parse(run?.finishedAt ?? latest.createdAt) < hours * hourMs)) return 0;
    const retry = latest ? `; the last discovery ${run?.error?.code === "AGENT_INCOMPLETE" ? "was incomplete" : latest.status}, retrying after ${hours} h` : "";
    enqueueTask({ subjectId: subject.id, action, reason: due + retry, input: { source: "storefront", kind: "site_map", triggerKey: written ?? "none" } });
    return 1;
  });
}

export async function saveSiteMap({ subject, task, run }: { subject: Subject; task: Task; run: Evaluated }) {
  const written = new Date().toISOString();
  await writeStateText("site.md", `Site map of ${liveUrl()}, written by ${botName} on ${written}.\n\n${run.result.text}\n`);
  sourceCursor(subject.repository, task.action, scope).save([written, await skillHash(run.skill), run.mainSha].join(" "));
}

export const knownBreakages = (known: Alerts | undefined) => Object.entries(known ?? {}).map(([fingerprint, { title, sha }]) => ({ fingerprint, title, since: sha }));

export async function stageBaselines(contextDir: string, write: (key: string, name: string, content: string) => Promise<void>, state: string) {
  const baselines = await readState<Baselines>(join(state, "baselines/index.json"), {}) ?? {};
  if (!Object.keys(baselines).length) return;
  await cp(statePath(state, "baselines"), join(contextDir, "baselines"), { recursive: true });
  await write("baselines", "baselines.json", JSON.stringify(Object.fromEntries(Object.entries(baselines).map(([key, { url, devices }]) => [key, {
    url, screenshots: Object.fromEntries(Object.entries(devices).map(([device, sha]) => [device, { path: join(contextDir, "baselines", key, `${device}.png`), sha }])),
  }])), null, 2));
}

export async function storefrontContext(subjectId: string, headSha: string, source: TriggerInput["source"]) {
  const discovery = source === "storefront", audit = source === "schedule", preview = discovery || audit ? undefined : previewContext(subjectId, headSha);
  if (!discovery && !audit && !preview) return undefined;
  const { devices, auditPaths, limits: { confirmationRuns, regressionMaxGrade } } = config.storefront;
  const context = preview ? { ...preview, liveUrl: liveUrl(), devices, confirmationRuns, regressionMaxGrade }
    : audit ? { liveUrl: liveUrl(), devices, confirmationRuns, auditPaths, knownBreakages: knownBreakages(await readState<Alerts>(join(auditState, "alerts.json"), {})) } : { liveUrl: liveUrl() };
  return { context, siteMap: await ifMissing(readFile(siteMapPath(), "utf8"), undefined), browse: preview?.available ?? true };
}

export async function pruneScreenshots(now = Date.now()) {
  const root = resolve("data/runs");
  for (const run of await ifMissing(readdir(root), [])) {
    for (const file of (await ifMissing(readdir(resolve(root, run)), [])).filter((name) => /^screenshot-.*\.png$/.test(name))) {
      const path = resolve(root, run, file), taken = await ifMissing(stat(path), undefined);
      if (taken && now - taken.mtimeMs > config.storefront.screenshotRetentionDays * dayMs) await rm(path, { force: true });
    }
  }
}
