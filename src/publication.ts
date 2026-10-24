import { manifestOf } from "./actions.ts";
import { db } from "./db.ts";
import { applyEffects, type EffectContext } from "./effects.ts";
import type { EventReferences } from "./events.ts";
import { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { getRun, updateRun } from "./run-history.ts";
import type { Run, Task, Subject } from "./schema.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";

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
  const manifest = manifestOf(task.action);
  const effectContext = { ...receiptContext(run, references), github, task, run: { ...run, result, context }, current };
  if (run.publication.commentOnly) {
    await applyEffects(["comment"], effectContext);
    await removeWorkspace(run.workspaceId!, references);
    return;
  }
  if (manifest.mode === "change") {
    const workspace = run.workspaceId ? getWorkspace(run.workspaceId) : undefined;
    if (!workspace || workspace.removedAt) throw new Error("Publication workspace is no longer active");
    const commitSha = run.publication.commitSha;
    if (!commitSha) throw new Error("Run has no validated commit to publish");
    return applyEffects(manifest.publish, { ...effectContext, workspace, commitSha });
  }
  return applyEffects(manifest.publish, effectContext);
}

export function publishCommit(subject: Subject, task: Task, run: Run) {
  const saved = getRun(run.id)!;
  return applyEffects(manifestOf(task.action).publish, { ...receiptContext(saved, {}), subject, task, run });
}

export function publishWindow(subject: Subject, task: Task, run: Run, references: EventReferences) {
  const saved = getRun(run.id)!;
  return applyEffects(manifestOf(task.action).publish, { ...receiptContext(saved, references), github: new GitHubRepository(subject.repository), subject, task, run: saved });
}
