import { buildAgentInput } from "./agent-input.ts";
import { config } from "./config.ts";
import type { Action } from "./manifests.ts";
import { runCommands } from "./commands.ts";
import type { GitHubRepository } from "./github.ts";
import type { startOperation } from "./logging.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import type { ItemObservation } from "./observation.ts";
import { executePi } from "./pi.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { InterruptedError } from "./results.ts";
import type { Item } from "./items.ts";
import type { Run, Task, Subject, Workspace } from "./schema.ts";

export type DatabaseConfig = NonNullable<typeof config.workspace.database>;
export type Environment = Record<string, string | undefined>;
type References = { subjectId: string; taskId: string; runId: string };

export const botAuthor = () => ({ name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com` });

export async function prepareWorkspace(workspace: Workspace, environment: Environment, references: References, databaseConfig?: DatabaseConfig | null) {
  await runCommands(config.workspace.prepare, workspace.path, environment, references, "prepare");
  if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, environment, references, "migrate");
}

export function stopBefore(stop: AbortSignal | undefined, next: string) {
  if (stop?.aborted) throw new InterruptedError(`Worker is stopping; run left at the stage boundary before ${next}`);
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
  environment: Environment; input: Omit<Parameters<typeof buildAgentInput>[0], "run" | "task">;
  sessionFile?: string; baseSha?: string; panel?: { baseSha: string; requireGrade: boolean };
}) {
  const { workspace } = input;
  const { prompt, contextDir, revisions, storefront } = await buildAgentInput({ run, task, ...input });
  const { browserSteps, browserSeconds } = config.storefront.limits;
  const browser = storefront && manifest.tools.includes("browser")
    ? { navigationHosts: "any" as const, resourceHosts: "any" as const, ...manifest.browser, limits: { steps: manifest.browserSteps ?? browserSteps, milliseconds: (manifest.browserSeconds ?? browserSeconds) * 1000 } } : manifest.browser;
  const options = { run, cwd: workspace.path, tools: manifest.tools, scoped: { ...manifest, browser }, storefront, contextDir, revisions, environment, log: operation.log, stop };
  const agentResult = panel
    ? await reviewPullRequest({ ...options, baseSha: panel.baseSha }, prompt, panel.requireGrade)
    : await executePi({ ...options, baseSha }, { context: prompt, sessionFile });
  return { result: { ...agentResult, paths: [...new Set([...input.diffPaths, ...agentResult.paths])] }, contextDir, revisions };
}
