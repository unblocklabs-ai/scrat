import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config, isActionEnabled } from "./config.ts";
import { ifMissing } from "./errors.ts";
import { botName } from "./identity.ts";
import { upsertSubject } from "./items.ts";
import type { Run, Subject, Task } from "./schema.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";
import { previewContext, statePath } from "./storefront.ts";

const scope = "site_map", dayMs = 86_400_000;
const siteMapPath = () => statePath("site.md");
const liveUrl = () => `https://${config.storefront.publicHost}/`;

export function pollSiteMap(repository = config.github.repository, now = new Date()) {
  return pollSource("site_map.poll", "storefront", repository, ({ name: action }) => {
    if (!isActionEnabled(action)) return 0;
    const written = sourceCursor(repository, action, scope).value;
    if (written && existsSync(siteMapPath()) && now.getTime() - Date.parse(written) < config.storefront.siteMapMaxAgeDays * dayMs) return 0;
    const end = now.toISOString();
    const subject = upsertSubject({ repository, kind: "window", key: `${action}:${written ?? "none"}`, metadata: { start: written ?? end, end } });
    return enqueueOnce(subject, action, written ? `the site map written ${written} is due` : "the store has no site map yet", { source: "storefront", kind: "site_map", triggerKey: written ?? "none" });
  });
}

export async function saveSiteMap({ subject, task, run }: { subject: Subject; task: Task; run: Run }) {
  if (!run.result) throw new Error("Run has no saved site map to store");
  const written = new Date().toISOString(), path = siteMapPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `Site map of ${liveUrl()}, written by ${botName} on ${written}.\n\n${run.result.text}\n`);
  await rename(`${path}.tmp`, path);
  sourceCursor(subject.repository, task.action, scope).save(written);
}

export async function storefrontContext(subjectId: string, headSha: string, discovery: boolean) {
  const preview = discovery ? undefined : previewContext(subjectId, headSha);
  if (!discovery && !preview) return undefined;
  const { devices, limits: { confirmationRuns, regressionMaxGrade } } = config.storefront;
  return {
    context: preview ? { ...preview, liveUrl: liveUrl(), devices, confirmationRuns, regressionMaxGrade } : { liveUrl: liveUrl() },
    siteMap: await ifMissing(readFile(siteMapPath(), "utf8"), undefined), browse: preview?.available ?? true,
  };
}
