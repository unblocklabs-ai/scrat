import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAgentInput } from "./agent-input.ts";
import { config } from "./config.ts";
import type { Action } from "./manifests.ts";
import { runCommands } from "./commands.ts";
import type { GitHubRepository } from "./github.ts";
import { gitList } from "./git.ts";
import type { startOperation } from "./logging.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import type { ItemObservation } from "./observation.ts";
import { executePi } from "./pi.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { ifMissing, SupersededError } from "./errors.ts";
import { InterruptedError } from "./results.ts";
import type { Item } from "./items.ts";
import type { Run, Task, Subject, Workspace } from "./schema.ts";

export type DatabaseConfig = NonNullable<typeof config.workspace.database>;
export type Environment = Record<string, string | undefined>;
type References = { subjectId: string; taskId: string; runId: string };

export const botAuthor = () => ({ name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com` });

export async function prepareInputsSignature(workspacePath: string): Promise<string | undefined> {
  if (!config.workspace.prepare.length || !config.workspace.prepareInputs.length) return undefined;
  try {
    const patterns = config.workspace.prepareInputs.map((pattern) => new RegExp(pattern));
    const files = (await gitList(workspacePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .filter((file) => patterns.some((re) => re.test(file)))
      .sort();
    const hash = createHash("sha256");
    hash.update(JSON.stringify(config.workspace.prepare));
    const nodeModules = await ifMissing(lstat(resolve(workspacePath, "node_modules")), undefined);
    hash.update(`\0node_modules:${nodeModules?.isDirectory() ? "dir" : nodeModules?.isSymbolicLink() ? "link" : "none"}\0`);
    for (const file of files) {
      const full = resolve(workspacePath, file);
      const stats = await ifMissing(lstat(full), undefined);
      hash.update(file);
      hash.update("\0");
      if (!stats) hash.update("missing");
      else if (stats.isSymbolicLink()) hash.update(`link:${await readlink(full)}`);
      else if (stats.isFile()) hash.update(await readFile(full));
      else hash.update("other");
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

export async function prepareWorkspace(
  workspace: Workspace,
  environment: Environment,
  references: References,
  databaseConfig?: DatabaseConfig | null,
  options?: { skipPrepare?: boolean; commands?: string[][] },
) {
  const commands = options?.commands ?? config.workspace.prepare;
  if (!options?.skipPrepare && commands.length) await runCommands(commands, workspace.path, environment, references, "prepare");
  if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, environment, references, "migrate");
}

export function stopBefore(stop: AbortSignal | undefined, next: string) {
  if (!stop?.aborted) return;
  if (stop.reason instanceof SupersededError) throw stop.reason;
  throw new InterruptedError(`Worker is stopping; run left at the stage boundary before ${next}`);
}

export type Ctx = {
  task: Task; run: Run; subject: Subject; item: Item | undefined;
  references: References; operation: ReturnType<typeof startOperation>;
  manifest: Action; repositoryPath: string; stop: AbortSignal | undefined;
  cleanup: { reviewWorkspace?: Workspace; databaseRequested: boolean };
};
export type Observed = {
  repository: string; github: GitHubRepository; context: GithubContext; pullRequest: GithubPullRequest | undefined;
  item: Item; observation: ItemObservation; mainSha: string;
};

export async function itemRevisions({ github, pullRequest, mainSha }: Observed) {
  const headSha = pullRequest ? await github.fetchPullRequestHead(pullRequest) : mainSha;
  return { mainSha, headSha };
}

export async function runAgent({ run, task, manifest, operation, stop }: Ctx, { environment, input, sessionFile, baseSha, panel }: {
  environment: Environment; input: Omit<Parameters<typeof buildAgentInput>[0], "run" | "task" | "manifest">;
  sessionFile?: string; baseSha?: string; panel?: { baseSha: string; requireGrade: boolean; beforeReview?: (storefront: boolean) => Run };
}) {
  const { workspace } = input;
  const { prompt, contextDir, revisions, storefront, labelCategories } = await buildAgentInput({ run, task, manifest, ...input });
  const activeRun = panel?.beforeReview ? panel.beforeReview(Boolean(storefront)) : run;
  const { browserSteps, browserSeconds } = config.storefront.limits;
  const browser = storefront && manifest.tools.includes("browser")
    ? { navigationHosts: "any" as const, resourceHosts: "any" as const, ...manifest.browser, limits: { steps: manifest.browserSteps ?? browserSteps, milliseconds: (manifest.browserSeconds ?? browserSeconds) * 1000 } } : manifest.browser;
  const options = { run: activeRun, cwd: workspace.path, tools: manifest.tools, scoped: { ...manifest, browser }, storefront, contextDir, revisions, environment, log: operation.log, stop };
  const agentResult = panel
    ? await reviewPullRequest({ ...options, baseSha: panel.baseSha }, prompt, panel.requireGrade)
    : await executePi({ ...options, baseSha }, { context: prompt, sessionFile, labelCategories });
  return { result: { ...agentResult, paths: [...new Set([...input.diffPaths, ...agentResult.paths])] }, contextDir, revisions };
}
