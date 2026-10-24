import { eq } from "drizzle-orm";
import { contextDirOf, evaluateContext, readDiffScope } from "./agent-input.ts";
import { config } from "./config.ts";
import type { Manifest } from "./manifests.ts";
import { botName } from "./identity.ts";
import { runCommands, withValidationSlot } from "./commands.ts";
import { createRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { describeError, type ErrorDetails, errorExitCode } from "./errors.ts";
import { conventionalTitle, git, headOf, hasPendingMerge, mergeBase, prepareTarget } from "./git.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { executePi } from "./pi.ts";
import { getRun, inferenceRunOf, latestSessionRun, updateRun } from "./run-history.ts";
import { assertComplete, type AgentResult, CheckFailure, hasValidationCheckpoint, InterruptedError } from "./results.ts";
import { subjects, workspaces, type Workspace } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, pinWorkspaceBase, stageTree, validateCheckpoint, validateWorkspace } from "./workspaces.ts";
import { botAuthor, type Ctx, type DatabaseConfig, type Environment, itemRevisions, type Observed, prepareWorkspace, runAgent, stopBefore } from "./run-context.ts";

type Acceptance = NonNullable<Manifest["acceptance"]>;

async function asCheckFailure<T>(fn: () => Promise<T>) {
  try { return await fn(); }
  catch (error) {
    const code = errorExitCode(error);
    if (error instanceof Error && code !== undefined && code <= 128
      && !("signal" in error && error.signal) && !("killed" in error && error.killed)) {
      throw new CheckFailure(error.message, { cause: error });
    }
    throw error;
  }
}

function validationMessage(error: CheckFailure, round: number) {
  const { message, exitCode, stdout } = describeError(error.cause);
  const output = stdout?.trim() ? `\nOutput (tail):\n${stdout.trim()}\n` : "";
  return `${botName}'s validation failed after your changes (round ${round} of ${config.harness.corrections.validation}).\n\nCommand: ${message.split("\n")[0].replace(/^Command failed: /, "")}\nExit code: ${exitCode ?? "unknown"}\n${output}\nFix only what is reported. ${botName} re-validates after your turn, so a full rerun of the failing check is not needed. Then end your turn with one or two sentences on what you changed to fix this (it is appended to your earlier handoff), and the usual SCRAT_STATUS footer (add SCRAT_READY if the change is still ready).`;
}

const unresolvedConflict = "PR still conflicts with its base branch after resolution";

const commitPurposes: Record<string, string> = { address_review: "Address review", address_pr_feedback: "Address feedback", resolve_conflicts: "Resolve conflicts" };

async function runChecks({ run, references, stop }: Ctx, p: Change) {
  const { workspace, commandEnvironment } = p;
  updateRun(run.id, { agentCheckpoint: await checkpointWorkspace(workspace) });
  await asCheckFailure(() => prepareWorkspace(workspace, commandEnvironment, references, p.databaseConfig));
  const checkpoint = await checkpointWorkspace(workspace);
  updateRun(run.id, { agentCheckpoint: checkpoint });
  const validationTree = checkpoint.treeSha;
  stopBefore(stop, "validation commands");
  const commands = await asCheckFailure(() => withValidationSlot(() => runCommands(config.workspace.validate, workspace.path, commandEnvironment, references, "validate"), references, stop)
    .catch((error) => { throw stop?.aborted && error === stop.reason ? new InterruptedError("Worker is stopping; run left waiting for a validation slot") : error; }));
  if (await stageTree(workspace.path) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
  return { commands, validationTree };
}

async function validateAndCommit(ctx: Ctx, p: Change, kind: Acceptance) {
  const { run, task, references } = ctx;
  const { workspace } = p;
  const { commands, validationTree } = await runChecks(ctx, p);
  await assertNoCommittedSecrets(workspace, p.validationOnly ? run.headSha ?? p.mainSha : p.startHeadSha, validationTree);
  const purpose = commitPurposes[task.action];
  const message = purpose ? `${purpose}: ${p.title}` : conventionalTitle(p.title);
  const commitSha = await commitWorkspace(workspace, message, botAuthor(), references);
  if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
  if (kind === "conflict_free") {
    const { conflicts } = await targetOf(p, commitSha);
    if (conflicts) throw new Error(unresolvedConflict);
  }
  const commentOnly = kind === "nonempty_diff" && !await git(workspace.path, ["diff", "--name-only", `${p.mainSha}...HEAD`]);
  updateRun(run.id, { headSha: commitSha, publication: { status: "pending", commitSha, ...commentOnly && { commentOnly } }, verification: { headSha: commitSha, commands }, stage: "publishing" });
}

type Change = {
  workspace: Workspace; validationOnly: boolean; mergeInProgress: boolean; mainSha: string;
  preparedHead: string; startHeadSha: string; headSha: string; title: string; deferred: boolean;
  target: Awaited<ReturnType<typeof prepareTarget>> | undefined;
  databaseConfig: DatabaseConfig | null | undefined;
  database: Awaited<ReturnType<typeof createRunDatabase>> | undefined;
  environment: Environment; commandEnvironment: Environment;
  result: AgentResult | null; validated: boolean; validationFailure: ErrorDetails | undefined;
  agentInput: { contextDir: string; revisions: Record<string, string> } | undefined;
};

async function targetOf(p: Change, headSha = p.headSha) {
  if (p.target?.headSha !== headSha || p.target.mainSha !== p.mainSha) p.target = await prepareTarget(p.workspace.path, p.mainSha, headSha);
  return p.target;
}

async function acquireChangeWorkspace(ctx: Ctx, observed: Observed) {
  const { repository, context, pullRequest, item, observation } = observed;
  const { run, references, repositoryPath } = ctx;
  const validationOnly = run.stage === "validating";
  const { mainSha, headSha: preparedHead } = await itemRevisions(ctx, observed);
  let workspace = item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
  if (workspace?.removedAt) throw new Error(`Workspace was removed: ${workspace.id}`);
  if (workspace) {
    await validateWorkspace(workspace);
    await git(workspace.path, ["fetch", "--no-tags", "--", `${repositoryPath}/.git`, preparedHead, mainSha]);
  }
  if (validationOnly) {
    if (!hasValidationCheckpoint(run)) throw new Error("No complete agent checkpoint to resume; use normal retry to repair");
    if (!workspace || workspace.id !== run.workspaceId) throw new Error("Validation checkpoint workspace is no longer attached to this item");
    if ((await freshness(savedEvaluation(run), { ...observation, mainSha }, "exact")).kind === "stale") {
      throw new Error("Validation checkpoint context or base changed; use normal retry to repair against current requirements");
    }
    await validateCheckpoint(workspace, run.agentCheckpoint);
  }
  if (!workspace) {
    if (pullRequest && pullRequest.head.repo?.full_name !== repository) {
      throw new Error("Cannot update a PR branch in a different repository");
    }
    workspace = await createWorkspace({ repositoryPath, baseRef: preparedHead, branch: pullRequest?.head.ref }, references);
    db.update(subjects).set({ workspaceId: workspace.id }).where(eq(subjects.id, item.id)).run();
  }
  const mergeInProgress = await hasPendingMerge(workspace.path);
  if (!mergeInProgress && !validationOnly) {
    if (pullRequest) {
      await git(workspace.path, ["merge", "--ff-only", preparedHead]);
      await pinWorkspaceBase(workspace, preparedHead);
    } else {
      try {
        await git(workspace.path, ["merge", "--ff-only", preparedHead]);
        if (await headOf(workspace.path) === preparedHead) {
          await pinWorkspaceBase(workspace, preparedHead);
          db.update(workspaces).set({ baseSha: preparedHead }).where(eq(workspaces.id, workspace.id)).run();
        }
      } catch (error) {
        ctx.operation.log.warn({ event: "workspace.base_update_skipped", workspaceId: workspace.id, err: error });
      }
    }
  }
  const startHeadSha = await headOf(workspace.path);
  return { workspace, validationOnly, mergeInProgress, mainSha, preparedHead, startHeadSha, title: context.item.title };
}

async function mergeBehindBase(p: Change, { observation, pullRequest }: Observed, fail?: unknown) {
  const { behind, conflicts } = await targetOf(p);
  if (!behind || conflicts) return false;
  await mergeBase(p.workspace.path, p.mainSha, `Merge ${observation.baseBranch} into ${pullRequest!.head.ref}`, botAuthor()).catch((error) => { throw fail ?? error; });
  p.headSha = await headOf(p.workspace.path);
  return true;
}

async function mergeBehind(ctx: Ctx, observed: Observed, p: Change, diffPaths: string[], acceptance: Acceptance) {
  const { run } = ctx;
  if (acceptance !== "conflict_free" || p.mergeInProgress || run.retryOfRunId) return false;
  if (!await mergeBehindBase(p, observed)) return false;
  const { baseBranch } = observed.observation;
  p.result = { text: `Merged ${baseBranch} (${p.mainSha.slice(0, 7)}) into this branch; no conflicts`, ready: false, paths: [...new Set(diffPaths)], outcome: "complete" };
  updateRun(run.id, { result: p.result, stage: "validating" });
  try {
    await validateAndCommit(ctx, p, acceptance);
    p.validated = true;
  } catch (error) {
    if (!(error instanceof CheckFailure) && !(error instanceof Error && error.message === unresolvedConflict)) throw error;
    p.validationFailure = describeError(error instanceof CheckFailure ? error.cause : error);
  }
  return true;
}

async function prepareChangeCommands({ references }: Ctx, observed: Observed, p: Change) {
  if (p.deferred) return false;
  try { await prepareWorkspace(p.workspace, p.commandEnvironment, references, p.databaseConfig); return false; }
  catch (error) {
    if (!observed.pullRequest || !await mergeBehindBase(p, observed, error)) throw error;
    await prepareWorkspace(p.workspace, p.commandEnvironment, references, p.databaseConfig);
    return true;
  }
}

async function correctionRound({ run, operation, manifest, stop }: Ctx, p: Change, result: AgentResult, round: number, error: CheckFailure) {
  const sessionFile = getRun(run.id)!.piSessionFile ?? undefined;
  if (!sessionFile || round > config.harness.corrections.validation) throw error.cause;
  operation.log.warn({ event: "pi.validation_retry", round });
  updateRun(run.id, { stage: "agent" });
  const followUp = await executePi({ run, cwd: p.workspace.path, context: "", tools: manifest.tools, scoped: manifest, log: operation.log, sessionFile, environment: p.environment, ...p.agentInput, followUp: validationMessage(error, round), stop });
  const corrected = { ...followUp, text: `${result.text}\n\n**Validation correction ${round}:** ${followUp.text}`, paths: [...new Set([...result.paths, ...followUp.paths])] };
  updateRun(run.id, { result: corrected, stage: "validating" });
  assertComplete(corrected);
  return corrected;
}

async function validateStage(ctx: Ctx, p: Change, acceptance: Acceptance) {
  const { run } = ctx;
  const { workspace, validationOnly } = p;
  let { result } = p;
  if (!result) throw new Error("No saved agent result to validate");
  assertComplete(result);
  const unchanged = acceptance === "complete" && !p.validated && !validationOnly
    && p.startHeadSha === p.preparedHead && !p.mergeInProgress && await headOf(workspace.path) === p.startHeadSha
    && !await git(workspace.path, ["status", "--porcelain"]);
  if (unchanged) updateRun(run.id, { publication: { status: "pending", commitSha: p.startHeadSha }, stage: "publishing" });
  else if (!p.validated) {
    for (let round = 1; ; round++) {
      try { await validateAndCommit(ctx, p, acceptance); break; }
      catch (error) {
        if (!(error instanceof CheckFailure)) throw error;
        result = await correctionRound(ctx, p, result, round, error);
      }
    }
  }
}

async function provisionDatabase({ run, references, cleanup }: Ctx) {
  const databaseConfig = config.workspace.database;
  let database: Change["database"];
  if (databaseConfig) {
    cleanup.databaseRequested = true;
    database = await createRunDatabase(run.id, databaseConfig.image, references);
  }
  const environment: Environment = { ...config.workspace.environment,
    ...Object.fromEntries((databaseConfig?.environment ?? []).map((name) => [name, database!.url])),
  };
  return { databaseConfig, database, environment };
}

async function agentStage(ctx: Ctx, observed: Observed, p: Change, acceptance: Acceptance, { diffPaths, diffBaseSha }: Awaited<ReturnType<typeof readDiffScope>>) {
  const { task, run, stop } = ctx;
  const { workspace, mainSha, environment, database } = p;
  const evaluated = evaluateContext(run, task, observed.observation);
  updateRun(run.id, { context: evaluated });
  const mergedBehind = await mergeBehind(ctx, observed, p, diffPaths, acceptance);
  if (p.validated) return;
  stopBefore(stop, "workspace preparation");
  const merged = await prepareChangeCommands(ctx, observed, p) || mergedBehind;
  stopBefore(stop, "the agent");
  updateRun(run.id, { stage: "agent" });
  const { result, contextDir, revisions } = await runAgent(ctx, {
    environment, sessionFile: latestSessionRun(workspace.id, run.id)?.piSessionFile ?? undefined,
    input: {
      workspace, evaluated, diffBaseSha: merged ? mainSha : diffBaseSha, diffPaths, mainSha, headSha: p.headSha, baseRef: mainSha, mergeInProgress: p.mergeInProgress, validationFailure: p.validationFailure,
      database: database ? { ...database, environment, schemaPrepared: !p.deferred, prepare: config.workspace.prepare, migrate: p.databaseConfig?.migrate } : undefined,
    },
  });
  p.agentInput = { contextDir, revisions };
  p.result = result;
  updateRun(run.id, { result: p.result, stage: "validating" });
}

export async function changeRun(ctx: Ctx, observed: Observed) {
  const { run, manifest } = ctx;
  const acceptance = manifest.acceptance!;
  const acquired = await acquireChangeWorkspace(ctx, observed);
  const { workspace, validationOnly, mainSha, startHeadSha } = acquired;
  if (!validationOnly) updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha: startHeadSha });
  const { databaseConfig, database, environment } = await provisionDatabase(ctx);
  const p: Change = {
    ...acquired, headSha: startHeadSha, databaseConfig, database, environment,
    commandEnvironment: { ...childEnvironment(), ...environment }, result: run.result,
    validated: false, validationFailure: undefined, agentInput: undefined, target: undefined,
    deferred: acquired.mergeInProgress || Boolean(run.retryOfRunId) || acceptance === "conflict_free",
  };
  const scope = await readDiffScope(workspace.path, mainSha, p.preparedHead, Boolean(observed.pullRequest));
  if (validationOnly) p.agentInput = { contextDir: contextDirOf(inferenceRunOf(run).id), revisions: { head: p.headSha, base: scope.diffBaseSha, main: mainSha } };
  else await agentStage(ctx, observed, p, acceptance, scope);
  await validateStage(ctx, p, acceptance);
}
