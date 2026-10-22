import type { evaluateContext } from "./agent-input.ts";
import { config } from "./config.ts";
import type { Subject } from "./schema.ts";

export function describeWindow(action: string, { repository, metadata }: Subject, mainSha: string) {
  if (!metadata || !("start" in metadata)) throw new Error("Window subject has no metadata");
  const evaluated: ReturnType<typeof evaluateContext> = {
    revision: metadata.end, baseBranch: config.github.baseBranch, headSha: undefined,
    item: { number: 0, title: `${action} ${metadata.start} to ${metadata.end}`, body: "", url: `https://github.com/${repository}` }, comments: [], commentRevisions: [],
  };
  return { evaluated, diffPaths: [] as string[], diffBaseSha: mainSha };
}
