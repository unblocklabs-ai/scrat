import { buildAgentInput } from "./agent-input.ts";
import { config } from "./config.ts";
import type { Manifest } from "./manifests.ts";
import { runCommands } from "./commands.ts";
import { fetchPullRequestHead } from "./git.ts";
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
  manifest: Manifest; repositoryPath: string; stop: AbortSignal | undefined;
  cleanup: { reviewWorkspace?: Workspace; databaseRequested: boolean };
};
export type Observed = {
  repository: string; github: GitHubRepository; context: GithubContext; pullRequest: GithubPullRequest | undefined;
  item: Item; observation: ItemObservation; gitEnvironment: NodeJS.ProcessEnv; mainSha: string;
};

export async function itemRevisions({ repositoryPath }: Ctx, { pullRequest, observation, gitEnvironment, mainSha }: Observed) {
  const headSha = pullRequest ? await fetchPullRequestHead(repositoryPath, observation.remote, pullRequest.number, pullRequest.head.sha, gitEnvironment) : mainSha;
  return { mainSha, headSha };
}

export async function tryCleanup(operation: Ctx["operation"], detail: Record<string, string>, fn: () => Promise<unknown>) {
  try { await fn(); }
  catch { operation.log.warn({ event: "run.cleanup_pending", ...detail }); }
}

export async function runAgent({ run, task, manifest, operation, stop }: Ctx, { environment, input, sessionFile, baseSha, panel }: {
  environment: Environment; input: Omit<Parameters<typeof buildAgentInput>[0], "run" | "task">;
  sessionFile?: string; baseSha?: string; panel?: { baseSha: string; requireGrade: boolean };
}) {
  const { workspace } = input;
  const { prompt, contextDir, revisions } = await buildAgentInput({ run, task, ...input });
  const shared = { tools: manifest.tools, scoped: manifest, contextDir, revisions, stop };
  const agentResult = panel
    ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { ...shared, ...panel })
    : await executePi({ run, cwd: workspace.path, context: prompt, log: operation.log, sessionFile, environment, baseSha, ...shared });
  return { result: { ...agentResult, paths: [...new Set([...input.diffPaths, ...agentResult.paths])] }, contextDir, revisions };
}
