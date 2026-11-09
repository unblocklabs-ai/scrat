import { isDeepStrictEqual } from "node:util";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { manifestOf, manifests } from "./actions.ts";
import { config, isActionEnabled } from "./config.ts";
import { findItem, sameRepository } from "./repository.ts";
import { db } from "./db.ts";
import { CompetingImplementation, competingImplementationCode, describeError, type ErrorDetails, errorCode, errorMessage, ImplementationEnded, transientInferenceCode } from "./errors.ts";
import type { GitHubRepository } from "./github.ts";
import type { IssueImplementation } from "./github-types.ts";
import { botSlug } from "./identity.ts";
import { recordEvent, type JournalEvent } from "./events.ts";
import { withOperationSync } from "./logging.ts";
import { entryStage, hasPublicationSnapshot, hasReviewCheckpoint, hasValidationCheckpoint, InterruptedError, workerStoppedMessage } from "./results.ts";
import { getRun, getTask, latestRunOfTask } from "./run-history.ts";
import { asItem } from "./items.ts";
import { categoriesFor, itemLabelKey } from "./item-labels.ts";
import { items, runs, type Run, subjects, tasks, type Task, type Subject, workspaces } from "./schema.ts";
import { isBaseOnly, isManual, parseTriggerInput, type TriggerInput } from "./triggers.ts";
import { signalWork } from "./work-signal.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const pendingTask = inArray(tasks.status, ["queued", "blocked"]);
const pendingTaskOf = (transaction: Pick<typeof db, "select">, subjectId: string, action: string) =>
  transaction.select().from(tasks).where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action), pendingTask)).get();

const isPending = (task: Task | undefined): task is Task & { status: "queued" | "blocked" } =>
  task?.status === "queued" || task?.status === "blocked";

function sameOpening(task: Task, facts: IssueImplementation) {
  return task.issueOpening === null
    ? !facts.reopenedAt || Date.parse(facts.reopenedAt) <= Date.parse(task.createdAt)
    : task.issueOpening === facts.opening;
}

export async function assertCurrentImplementation(github: GitHubRepository, task: Task, issue: number, base: string, branch?: string, checkCompetition = true) {
  const facts = await github.issueImplementation(issue, base, branch, task.createdAt);
  if (!facts.open || !sameOpening(task, facts)) throw new ImplementationEnded(facts.open ? "GitHub issue reopened" : "GitHub issue closed");
  if (task.issueOpening === null) {
    db.update(tasks).set({ issueOpening: facts.opening }).where(eq(tasks.id, task.id)).run();
    task.issueOpening = facts.opening;
  }
  if (checkCompetition && facts.competingPullRequest !== undefined) throw new CompetingImplementation(facts.competingPullRequest);
}

export function latestTask(subjectId: string, action: string, database: Pick<typeof db, "select"> = db) {
  return database.select().from(tasks).where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1).get();
}

const modeOf = (action: string) => manifests.find(({ name }) => name === action)?.mode;

function checkClaimable({ task, subject }: { task: Task; subject: Subject }, database: Pick<typeof db, "select">) {
  if (!isActionEnabled(task.action)) return { ok: false as const, reason: `Unknown action: ${task.action}` };
  let trigger;
  try { trigger = parseTriggerInput(task.input); }
  catch (error) { return { ok: false as const, reason: `Invalid trigger input for ${task.action}: ${errorMessage(error)}` }; }
  const { repository } = subject;
  if (!sameRepository(repository, config.github.repository)) return { ok: false as const, reason: `Subject belongs to ${repository}, not ${config.github.repository}` };
  const previousRun = latestRunOfTask(task.id, database);
  return { ok: true as const, previousRun, trigger };
}

function planRunStart(task: Task, { previousRun, trigger }: { previousRun: Run | undefined; trigger: TriggerInput }) {
  const retry = previousRun?.error && isDeepStrictEqual(previousRun.input, task.input) ? previousRun : undefined;
  const action = manifestOf(task.action);
  const resumingDeferred = task.lastCompetingPullRequest !== null;
  const validationOnly = task.retryMode === "validation"
    || retry?.error?.code === competingImplementationCode && hasValidationCheckpoint(retry);
  const publicationResume = !validationOnly && hasPublicationSnapshot(retry) ? retry : undefined;
  const interrupted = retry?.error?.name === "InterruptedError";
  const review = action.mode === "review";
  const reviewResume = interrupted && review && !validationOnly && hasReviewCheckpoint(retry) ? retry : undefined;
  const resume = validationOnly ? (hasValidationCheckpoint(retry) ? retry : undefined) : publicationResume ?? reviewResume;
  const prior = interrupted && !resume ? undefined : retry;
  const resumeReason = !interrupted ? "retry" as const : retry?.error?.message === workerStoppedMessage ? "crash" as const : "drain" as const;
  const pinned = review && !resume ? undefined : prior;
  const settings = pinned ?? action;
  const reviewers = resume ? resume.reviewers : pinned?.reviewers ?? (isBaseOnly(trigger) ? action.reviewers.slice(0, 1) : action.reviewers);
  const { provider, model, thinkingLevel } = !resume && reviewers.length === 1 ? reviewers[0] : settings;
  return { prior, resume, publicationResume, review, reviewers, skill: settings.skill, provider, model, thinkingLevel, resumeReason, resumingDeferred,
    stage: entryStage(retry, validationOnly ? "validation" : "repair", reviewResume) };
}

export function enqueueTask(task: Pick<typeof tasks.$inferInsert, "subjectId" | "action" | "priority" | "reason"> & { input: TriggerInput }) {
  return withOperationSync("task.enqueue", { subjectId: task.subjectId, action: task.action }, (operation) => {
    manifestOf(task.action);
    const queued = db.transaction((transaction) => {
      const previous = pendingTaskOf(transaction, task.subjectId, task.action);
      if (previous?.status === "blocked") return previous;
      const input = isManual(task.input) && previous ? { ...previous.input, manual: true }
        : previous && isManual(previous.input) ? { ...task.input, manual: true } : task.input;
      const queuedTask = transaction.insert(tasks).values({ ...task, input, priority: task.priority ?? config.actions[task.action].priority }).onConflictDoUpdate({
        target: [tasks.subjectId, tasks.action],
        targetWhere: sql`${tasks.status} in ('queued', 'blocked')`,
        set: {
          priority: task.priority ?? tasks.priority,
          reason: task.reason,
          input,
          retryMode: "repair",
          retryCount: null,
          availableAt: null,
        },
      }).returning().get()!;
      const references = { subjectId: queuedTask.subjectId, taskId: queuedTask.id, operationId: operation.operationId };
      recordEvent(previous ? {
        ...references,
        type: "task.coalesced",
        data: {
          action: queuedTask.action,
          previous: { priority: previous.priority, reason: previous.reason },
          current: { priority: queuedTask.priority, reason: queuedTask.reason },
          inputChanged: !isDeepStrictEqual(previous.input, queuedTask.input),
        },
      } : {
        ...references,
        type: "task.enqueued",
        data: { action: queuedTask.action, priority: queuedTask.priority, reason: queuedTask.reason },
      }, transaction);
      return queuedTask;
    }, { behavior: "immediate" });
    operation.complete({ taskId: queued.id, priority: queued.priority });
    signalWork();
    return queued;
  });
}

type ManualEnqueueResult = { target: string; number?: number; itemId?: string; taskId?: string; error?: string };

export function enqueueManualTasks(action: string, targets: string[], priority?: number): ManualEnqueueResult[] {
  const manifest = manifests.find(({ name }) => name === action);
  if (!manifest) throw new Error(`Unknown action: ${action}; expected one of ${manifests.map(({ name }) => name).join(", ")}`);
  if (manifest.trigger.manual === false) throw new Error(`${action} is queued automatically by sync and cannot be enqueued by hand`);
  const needs = manifest.trigger.item;
  if (!needs && manifest.trigger.kind !== "item_labels") throw new Error(`${action} is not triggered by an issue or PR`);
  return targets.map((target): ManualEnqueueResult => {
    const item = findItem(config.github.repository, target);
    if (!item) return { target, error: `No item ${target} in ${config.github.repository}` };
    const base = { target, number: item.payload.number, itemId: item.id };
    if (item.state !== "open") return { ...base, error: "Item is closed" };
    if (needs && item.kind !== needs) return { ...base, error: `${action} needs ${needs === "pr" ? "a PR" : "an issue"}, but ${target} is ${item.kind === "pr" ? "a PR" : "an issue"}` };
    if (manifest.trigger.kind === "item_labels" && !categoriesFor(manifestOf(action), item.kind).length) return { ...base, error: `${action} has no label categories enabled for ${item.kind}` };
    const input: TriggerInput = manifest.trigger.kind === "item_labels"
      ? { source: "github_items", kind: "item_labels", triggerKey: itemLabelKey(item.payload, categoriesFor(manifestOf(action), item.kind)), manual: true }
      : { source: "github_items", kind: "manual", manual: true };
    try { return { ...base, taskId: enqueueTask({ subjectId: item.id, action, priority, reason: "Manually enqueued", input }).id }; }
    catch (error) { return { ...base, error: errorMessage(error) }; }
  });
}

export function claimTask() {
  return db.transaction((transaction) => {
    const active = transaction.select({ count: count() }).from(tasks).where(eq(tasks.status, "running")).get()!;
    if (active.count >= config.harness.maxConcurrency) return;
    const busyTasks = alias(tasks, "busy_tasks");
    const busySubjects = alias(subjects, "busy_subjects");
    const select = () => transaction.select({ task: tasks, subject: subjects }).from(tasks)
      .innerJoin(subjects, eq(tasks.subjectId, subjects.id))
      .where(and(eq(tasks.status, "queued"), eq(subjects.state, "open"), or(isNull(tasks.availableAt), lte(tasks.availableAt, new Date().toISOString())), notExists(
        transaction.select({ id: busyTasks.id }).from(busyTasks)
          .innerJoin(busySubjects, eq(busyTasks.subjectId, busySubjects.id))
          .where(and(eq(busyTasks.status, "running"), or(
            eq(busyTasks.subjectId, tasks.subjectId),
            and(isNotNull(subjects.workspaceId), eq(busySubjects.workspaceId, subjects.workspaceId)),
          ))),
      )))
      .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id)).limit(1).get();
    let next, claimable;
    while ((next = select())) {
      claimable = checkClaimable(next, transaction);
      if (claimable.ok) break;
      transaction.update(tasks).set({ status: "failed" }).where(eq(tasks.id, next.task.id)).run();
      recordEvent({ subjectId: next.task.subjectId, taskId: next.task.id, type: "task.rejected", data: { action: next.task.action, reason: claimable.reason } }, transaction);
    }
    if (!next || !claimable?.ok) return;
    const { prior, resume, publicationResume, review, reviewers, skill, provider, model, thinkingLevel, resumeReason, stage, resumingDeferred } = planRunStart(next.task, claimable);
    // A newly selected opening does not inherit the previous opening's checkout.
    if (!claimable.previousRun && claimable.trigger.kind === "label" && claimable.trigger.freshOpening && next.subject.workspaceId) {
      const oldId = next.subject.workspaceId;
      transaction.update(subjects).set({ workspaceId: null }).where(eq(subjects.id, next.subject.id)).run();
      next.subject.workspaceId = null;
      if (!transaction.select({ id: subjects.id }).from(subjects).where(eq(subjects.workspaceId, oldId)).get()) {
        const retained = transaction.update(workspaces).set({ retainedAt: new Date().toISOString() })
          .where(and(eq(workspaces.id, oldId), isNull(workspaces.removedAt), isNull(workspaces.retainedAt))).returning().get();
        if (retained) recordEvent({ subjectId: next.subject.id, taskId: next.task.id, type: "workspace.retained",
          data: { workspaceId: oldId, path: retained.path, reason: "GitHub issue reopened" } }, transaction);
      }
    }
    const task = transaction.update(tasks).set({ status: "running" }).where(eq(tasks.id, next.task.id)).returning().get()!;
    const run = transaction.insert(runs).values({
      taskId: task.id,
      sequence: sql`(select coalesce(max(${runs.sequence}), 0) + 1 from ${runs})`,
      retryOfRunId: prior?.id,
      inferenceFromRunId: resume?.id,
      input: task.input,
      skill,
      provider, model, thinkingLevel, reviewers,
      workspaceId: resume?.workspaceId ?? (review ? null : next.subject.workspaceId),
      publication: publicationResume ? { ...publicationResume.publication, status: "pending" } : { status: "pending" },
      stage,
      ...(resume ? {
        context: resume.context, result: resume.result, mainSha: resume.mainSha, headSha: resume.headSha,
        piSessionId: resume.piSessionId, piSessionFile: resume.piSessionFile,
        agentCheckpoint: resume.agentCheckpoint,
        verification: publicationResume?.verification,
      } : {}),
      startedAt: new Date().toISOString(),
    }).returning().get()!;
    if (!claimable.previousRun && claimable.trigger.kind === "low_grade") {
      transaction.update(items).set({ selfRepairCount: sql`${items.selfRepairCount} + 1` }).where(eq(items.id, task.subjectId)).run();
    }
    recordEvent({ subjectId: task.subjectId, taskId: task.id, runId: run.id, type: "run.started", data: {
      action: task.action, skill: run.skill, provider: run.provider, model: run.model, thinkingLevel: run.thinkingLevel,
    } }, transaction);
    if (resume) recordEvent({ subjectId: task.subjectId, taskId: task.id, runId: run.id, type: "run.resumed", data: { stage: run.stage, fromRunId: resume.id, reason: resumeReason } }, transaction);
    const item = transaction.select().from(items).where(eq(items.id, task.subjectId)).get();
    return { task, subject: next.subject, item: item && asItem(item, next.subject), run, resumingDeferred };
  }, { behavior: "immediate" });
}

export function retryTask(taskId: string, mode: Task["retryMode"] = "repair") {
  return withOperationSync("task.retry", { taskId }, (operation) => {
    const task = db.transaction((transaction) => {
      const waiting = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "queued"), isNotNull(tasks.availableAt))).get();
      if (waiting && mode !== "repair") throw new Error(`A delayed task can only be retried in repair mode: ${taskId}`);
      const delayed = transaction.update(tasks).set({ availableAt: null })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "queued"), isNotNull(tasks.availableAt))).returning().get();
      if (delayed) {
        recordEvent({ subjectId: delayed.subjectId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: delayed.action, mode } }, transaction);
        return delayed;
      }
      const failed = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "failed"))).get();
      if (!failed) throw new Error(`Task is not failed: ${taskId}`);
      const queued = pendingTaskOf(transaction, failed.subjectId, failed.action);
      if (queued) throw new Error(`A queued task already exists for this subject/action: ${queued.id}`);
      if (mode === "validation") {
        const previous = latestRunOfTask(taskId, transaction);
        if (modeOf(failed.action) !== "change" || !hasValidationCheckpoint(previous)
          || !isDeepStrictEqual(previous.input, failed.input)) {
          throw new Error("Validation-only retry requires an unchanged task input and a complete agent checkpoint from a failed validation; use normal retry to repair");
        }
      }
      const updated = transaction.update(tasks).set({ status: "queued", retryMode: mode, retryCount: null, availableAt: null }).where(eq(tasks.id, taskId)).returning().get()!;
      recordEvent({ subjectId: updated.subjectId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: updated.action, mode } }, transaction);
      return updated;
    }, { behavior: "immediate" });
    operation.complete();
    signalWork();
    return task;
  });
}

function closeRun(transaction: Transaction, runId: string, error: ErrorDetails | null, plan: (run: Run) => { set: Partial<typeof tasks.$inferInsert>; event: JournalEvent }) {
  const run = transaction.update(runs).set({ error, finishedAt: new Date().toISOString() })
    .where(and(eq(runs.id, runId), isNull(runs.finishedAt))).returning().get();
  if (!run) throw new Error(`Run not active: ${runId}`);
  const { set, event } = plan(run);
  const task = transaction.update(tasks).set(set).where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running"))).returning().get();
  if (!task) throw new Error(`Task not running: ${run.taskId}`);
  recordEvent({ subjectId: task.subjectId, taskId: task.id, runId, ...event }, transaction);
  return run;
}

export function finishRun(runId: string, outcome: { status: "completed" } | { status: "failed" | "cancelled"; error: unknown }) {
  const error = outcome.status === "completed" ? null : describeError(outcome.error);
  const finished = db.transaction((transaction) => closeRun(transaction, runId, error, (run) => ({
    set: { status: outcome.status, lastCompetingPullRequest: null, ...outcome.status === "completed" ? { retryCount: null, availableAt: null } : {} },
    event: outcome.status === "cancelled" ? cancelled(getTask(run.taskId, transaction)!, error!.message)
      : error ? { type: "run.failed", data: { stage: run.stage, error } } : { type: "run.completed", data: { stage: run.stage } },
  })), { behavior: "immediate" });
  signalWork();
  return finished;
}

const blockedBy = (lastCompetingPullRequest: number) => ({ status: "blocked" as const, lastCompetingPullRequest });
const cancelled = (task: Task, reason: string) => ({ type: "task.cancelled" as const, data: { action: task.action, reason } });

export function deferImplementation(runId: string, error: CompetingImplementation) {
  const finished = db.transaction((transaction) => closeRun(transaction, runId, describeError(error), (run) => {
    const task = getTask(run.taskId, transaction)!;
    const subject = transaction.select().from(subjects).where(eq(subjects.id, task.subjectId)).get();
    if (subject?.state !== "open" || pendingTaskOf(transaction, task.subjectId, task.action)) {
      return { set: { status: "cancelled", lastCompetingPullRequest: null }, event: cancelled(task, "Implementation closed or superseded") };
    }
    return {
      set: { ...blockedBy(error.pullRequestNumber), retryMode: "repair", retryCount: null, availableAt: null },
      event: { type: "run.deferred", data: { stage: run.stage, competingPullRequest: error.pullRequestNumber } },
    };
  }), { behavior: "immediate" });
  signalWork();
  return finished;
}

export function reconcileIssueImplementation({ subjectId, action, observedTask, facts, input, selected, newlySelected }: {
  subjectId: string; action: string; observedTask?: Task; facts: IssueImplementation;
  input: Extract<TriggerInput, { kind: "label" }>; selected: boolean; newlySelected: boolean;
}) {
  const queued = db.transaction((transaction) => {
    const latest = latestTask(subjectId, action, transaction);
    const subject = transaction.select().from(subjects).where(eq(subjects.id, subjectId)).get();
    if (subject?.state !== "open" || latest?.id !== observedTask?.id || latest?.status !== observedTask?.status
      || latest?.issueOpening !== observedTask?.issueOpening || latest?.lastCompetingPullRequest !== observedTask?.lastCompetingPullRequest) return false;
    const newOpening = latest !== undefined && !sameOpening(latest, facts);
    const competitor = facts.competingPullRequest;
    const set = competitor === undefined ? { status: "queued" as const } : blockedBy(competitor);
    if (isPending(latest)) {
      if (!facts.open || newOpening) {
        transaction.update(tasks).set({ status: "cancelled", lastCompetingPullRequest: null }).where(eq(tasks.id, latest.id)).run();
        recordEvent({ subjectId, taskId: latest.id, ...cancelled(latest, facts.open ? "GitHub issue reopened" : "GitHub issue closed") }, transaction);
      } else {
        if (latest.status === set.status && (competitor === undefined || latest.lastCompetingPullRequest === competitor)
          && latest.issueOpening !== null) return false;
        transaction.update(tasks).set({ ...set, issueOpening: facts.opening }).where(eq(tasks.id, latest.id)).run();
        if (competitor !== undefined && latest.status === "queued") {
          recordEvent({ subjectId, taskId: latest.id, type: "task.blocked", data: { action, competingPullRequest: competitor } }, transaction);
        }
        if (competitor === undefined && latest.status === "blocked") {
          recordEvent({ subjectId, taskId: latest.id, type: "task.resumed", data: { action } }, transaction);
          return true;
        }
        return false;
      }
    }
    if (!selected || !facts.open || !newOpening && (competitor !== undefined || subject.workspaceId
      || latest && latest.status !== "cancelled" && !newlySelected)) return false;
    const task = transaction.insert(tasks).values({ ...set, subjectId, action,
      input: newOpening ? { ...input, freshOpening: true } : input, issueOpening: facts.opening,
      priority: config.actions[action].priority, reason: newOpening ? "Selected GitHub issue reopened" : `Issue has the ${botSlug} label`,
    }).returning().get()!;
    recordEvent({ subjectId, taskId: task.id, type: "task.enqueued", data: { action, priority: task.priority, reason: task.reason } }, transaction);
    if (competitor !== undefined) recordEvent({ subjectId, taskId: task.id, type: "task.blocked", data: { action, competingPullRequest: competitor } }, transaction);
    return competitor === undefined;
  }, { behavior: "immediate" });
  if (queued) signalWork();
  return queued;
}

export function retryTransientFailure(runId: string, error: unknown) {
  const run = getRun(runId);
  const task = run && getTask(run.taskId);
  const retry = task && modeOf(task.action) === "review" ? config.actions[task.action]?.retry : undefined;
  if (!run || !retry || run.stage !== "agent" || errorCode(error) !== transientInferenceCode) return false;
  interruptRun(runId, error, retry);
  return true;
}

export function interruptRun(runId: string, error: unknown = new InterruptedError(workerStoppedMessage), retry?: { initialDelaySeconds: number; maxDelaySeconds: number }) {
  const details = describeError(error);
  const interrupted = db.transaction((transaction) => closeRun(transaction, runId, details, (run) => {
    const own = getTask(run.taskId, transaction)!;
    const superseded = pendingTaskOf(transaction, own.subjectId, own.action);
    const retryMode = hasValidationCheckpoint(run) ? "validation" : "repair";
    const attempt = (own.retryCount ?? 0) + 1;
    const delaySeconds = retry && Math.min(retry.maxDelaySeconds, retry.initialDelaySeconds * 2 ** (attempt - 1) * (1 + config.harness.retryJitter * Math.random()));
    const nextAttemptAt = delaySeconds === undefined ? undefined : new Date(Date.now() + delaySeconds * 1000).toISOString();
    return {
      set: superseded ? { status: "failed", lastCompetingPullRequest: null } : { status: "queued", retryMode, ...nextAttemptAt ? { retryCount: attempt, availableAt: nextAttemptAt } : {} },
      event: superseded ? { type: "run.failed", data: { stage: run.stage, error: details } }
        : { type: "run.requeued", data: { stage: run.stage, retryMode, ...nextAttemptAt ? { attempt, nextAttemptAt } : {} } },
    };
  }), { behavior: "immediate" });
  signalWork();
  return interrupted;
}

export function cancelPendingTasks(subjectId: string, reason: string, action?: Task["action"], keepManual = false) {
  return db.transaction((transaction) => {
    const cancelled = transaction.update(tasks).set({ status: "cancelled", lastCompetingPullRequest: null }).where(and(
      eq(tasks.subjectId, subjectId), pendingTask, action ? eq(tasks.action, action) : undefined,
      keepManual ? sql`coalesce(json_extract(${tasks.input}, '$.manual'), 0) != 1` : undefined,
    )).returning().all();
    for (const task of cancelled) {
      recordEvent({ subjectId, taskId: task.id, type: "task.cancelled", data: { action: task.action, reason } }, transaction);
    }
    return cancelled;
  }, { behavior: "immediate" });
}
