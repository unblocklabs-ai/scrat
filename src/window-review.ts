import type { evaluateContext } from "./agent-input.ts";
import { config } from "./config.ts";
import { GitHubRepository } from "./github.ts";
import type { Ctx } from "./run-context.ts";

export async function describeWindow({ subject: { repository, metadata }, task }: Ctx) {
  if (!metadata || !("start" in metadata)) throw new Error("Window subject has no metadata");
  const mainSha = await new GitHubRepository(repository).fetchBranch(config.github.baseBranch);
  const evaluated: ReturnType<typeof evaluateContext> = {
    revision: metadata.end, baseBranch: config.github.baseBranch, headSha: undefined,
    item: { number: 0, title: `${task.action} ${metadata.start} to ${metadata.end}`, body: "", url: `https://github.com/${repository}` }, comments: [], commentRevisions: [],
  };
  return { mainSha, headSha: mainSha, evaluated, diffPaths: [] as string[], diffBaseSha: mainSha };
}
