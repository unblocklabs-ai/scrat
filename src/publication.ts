import { manifestOf } from "./actions.ts";
import { db } from "./db.ts";
import { applyEffects, type EffectContext } from "./effects.ts";
import type { EventReferences } from "./events.ts";
import { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { bestEffort, logger } from "./logging.ts";
import { updateRun } from "./run-history.ts";
import type { Run, Task, Subject } from "./schema.ts";
import { getWorkspace, removeWorkspace } from "./workspaces.ts";

export async function publishRun(github: GitHubRepository, subject: Subject, task: Task, run: Run, references: EventReferences, current?: GithubContext) {
  const { result, context } = run;
  if (!result || !context) throw new Error("Run has no evaluated result to publish");
  if (result.outcome !== "complete") throw new Error("Incomplete agent work cannot be published");
  const manifest = manifestOf(task.action);
  let publication = run.publication;
  const effectContext: EffectContext = {
    references, github, subject, task, run: { ...run, result, context }, current,
    publication: () => publication,
    saveReceipt(patch, database = db) {
      publication = { ...publication, ...patch };
      updateRun(run.id, { publication }, database);
    },
  };
  if (run.publication.commentOnly) {
    await applyEffects(["comment"], effectContext);
    const { workspaceId } = run;
    if (workspaceId) await bestEffort(logger, "run.cleanup_pending", { ...references, workspaceId }, () => removeWorkspace(workspaceId, references));
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
