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
  if (config.storefront.enabled) {
    const site = await import("./storefront-site.ts");
    await attempt(async () => { if (await site.pollSiteMap()) signalWork(); });
    await attempt(() => site.pruneScreenshots());
    const changes = await import("./store-changes.ts");
    await attempt(async () => { if (await changes.pollStoreChanges()) signalWork(); });
  }
  if (config.cloudflare.enabled) {
    const cloudflare = await import("./cloudflare.ts");
    await attempt(() => cloudflare.pollCloudflareIssues());
  }
}
