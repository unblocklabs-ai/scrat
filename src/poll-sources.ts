import { attempt } from "./cli.ts";
import { pollCommits } from "./commit-source.ts";
import { config } from "./config.ts";
import { syncGitHub } from "./github-sync.ts";
import { pollSchedules } from "./schedule-source.ts";
import { signalWork } from "./work-signal.ts";

export async function pollSources() {
  await attempt(async () => { await syncGitHub(); signalWork(); });
  await attempt(async () => { if (await pollCommits()) signalWork(); });
  await attempt(async () => { if (await pollSchedules()) signalWork(); });
  if (config.storefront.enabled) await attempt(async () => { if (await (await import("./storefront-site.ts")).pollSiteMap()) signalWork(); });
  if (config.storefront.enabled) await attempt(async () => (await import("./storefront-site.ts")).pruneScreenshots());
}
