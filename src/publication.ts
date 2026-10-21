import { actionContracts } from "./actions.ts";
import { db } from "./db.ts";
import { applyEffects, type EffectContext } from "./effects.ts";
import type { EventReferences } from "./events.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { getRun, updateRun } from "./run-history.ts";
import type { Run, Task, Subject } from "./schema.ts";
import { getWorkspace } from "./workspaces.ts";

function receiptContext(run: Run, references: EventReferences): EffectContext {
  let publication = run.publication;
  return {
    references,
    publication: () => publication,
    saveReceipt(patch, database = db) {
      publication = { ...publication, ...patch };
      updateRun(run.id, { publication }, database);
    },
  };
}

export async function publishRun(github: GitHubRepository, task: Task, run: Run, current: GithubContext, references: EventReferences) {
  const { result, context } = run;
  if (!result || !context) throw new Error("Run has no evaluated result to publish");
  if (result.outcome !== "complete") throw new Error("Incomplete agent work cannot be published");
  const contract = actionContracts[task.action];
  const effectContext = { ...receiptContext(run, references), github, task, run: { ...run, result, context }, current };
  if (contract.mode === "change") {
    const workspace = run.workspaceId ? getWorkspace(run.workspaceId) : undefined;
    if (!workspace || workspace.removedAt) throw new Error("Publication workspace is no longer active");
    const commitSha = run.publication.commitSha;
    if (!commitSha) throw new Error("Run has no validated commit to publish");
    return applyEffects(contract.publication, { ...effectContext, workspace, commitSha });
  }
  return applyEffects(contract.publication, effectContext);
}

export function publishCommit(subject: Subject, run: Run) {
  const saved = getRun(run.id)!;
  return applyEffects("slack-thread", { ...receiptContext(saved, {}), subject, run });
}
