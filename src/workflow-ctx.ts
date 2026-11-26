import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { upsertComment } from "./comments.ts";
import { config, isBotLogin } from "./config.ts";
import { db } from "./db.ts";
import { describeError, errorCode, SupersededError, transientInferenceCode } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { GitHubRepository } from "./github.ts";
import type { GithubIssue, GithubPullRequest } from "./github-types.ts";
import type { ThinkingLevel, ToolName } from "./manifests.ts";
import { endsWithMarker, fingerprintMarker, isIssueComment, withMarker } from "./markers.ts";
import { executePi, type SubmitResultSpec } from "./pi.ts";
import { InterruptedError, SecretLeakError } from "./results.ts";
import { updateRun } from "./run-history.ts";
import { steps, workflowState, type Run, type Subject, type Task } from "./schema.ts";
import { assertPublishable } from "./secrets.ts";
import { postMessage } from "./slack.ts";
import { type GithubPermission, hashJson, type ResolvedWorkflow, type SlackPermission, workflowAllowedTools, type WorkspacePermission } from "./workflows.ts";
import { createWorkspace, removeWorkspace } from "./workspaces.ts";

type WorkflowCheckout = {
  id: string;
  path: string;
  baseSha: string;
  ref: string;
};

type WorkflowAgentOptions = {
  cwd: string;
  skill?: string;
  input?: Record<string, unknown>;
  context?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: readonly ToolName[];
  codemode?: boolean;
  submitResult?: SubmitResultSpec;
};

type WorkflowAgentResult<T = Record<string, unknown>> = {
  text: string;
  data?: T;
  outcome: "complete" | "incomplete" | "needs_decision";
  paths: string[];
  sessionId?: string;
  sessionFile?: string;
};

type WorkflowMergedPr = {
  number: number;
  title: string;
  body: string;
  url: string;
  mergedAt: string;
  labels: string[];
  author: string;
};

export type WorkflowContext = {
  workflow: {
    name: string;
    dir: string;
    hash: string;
    dryRun: boolean;
    config: Record<string, unknown>;
  };
  trigger: {
    kind: "cron" | "manual";
    input: Record<string, unknown>;
    start?: string;
    end?: string;
  };
  signal: AbortSignal;
  log: Logger;
  step: <T>(name: string, input: unknown, fn: () => Promise<T>) => Promise<T>;
  parallel: <T extends Record<string, () => Promise<unknown>>>(entries: T) => Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
  state: {
    get: <T = unknown>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
    update: <T>(key: string, fn: (current: T | undefined) => T) => T;
    delete: (key: string) => void;
  };
  workspace: {
    baseBranch: string;
    withCheckout: <T>(ref: string, fn: (ws: WorkflowCheckout) => Promise<T>) => Promise<T>;
  };
  agent: {
    run: <T = Record<string, unknown>>(options: WorkflowAgentOptions) => Promise<WorkflowAgentResult<T>>;
  };
  github: {
    listOpenItems: () => Promise<{ issues: GithubIssue[]; pullRequests: GithubPullRequest[] }>;
    listOpenIssues: () => Promise<GithubIssue[]>;
    listOpenPrs: () => Promise<GithubPullRequest[]>;
    listRecentMergedPrs: (sinceDays: number, limit?: number) => Promise<WorkflowMergedPr[]>;
    comment: (args: { key: string; number: number; body: string }) => Promise<{ commentId: number; dryRun?: boolean; previewPath?: string }>;
    issue: (args: { key: string; title: string; body: string; labels?: string[] }) => Promise<{ number: number; created: boolean; dryRun?: boolean; previewPath?: string }>;
  };
  slack: {
    post: (args: { key: string; channel: string; text: string; threadTs?: string }) => Promise<{ ts: string; dryRun?: boolean; previewPath?: string }>;
  };
};

function ensureJsonSerializable<T>(label: string, value: T): T {
  try {
    const serialized = JSON.stringify(value === undefined ? null : value);
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const effectPrefix = "__effect:";

function unwrapState(value: unknown) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "v") return (value as { v: unknown }).v;
  }
  return value;
}

function assertNotAborted(signal: AbortSignal, stage: string) {
  if (!signal.aborted) return;
  if (signal.reason instanceof SupersededError) throw signal.reason;
  if (signal.reason instanceof InterruptedError) throw signal.reason;
  throw new InterruptedError(`Workflow aborted before ${stage}`);
}

function assertPermission<T extends string>(allowed: readonly T[], needed: T, scope: string, workflow: string) {
  if (!allowed.includes(needed)) {
    throw new Error(`Workflow ${workflow} lacks permission ${scope}:${needed} in workflow.yaml`);
  }
}

const allowedToolSet = new Set<string>(workflowAllowedTools);

function safeIdempotencyKey(key: string, workflowName: string) {
  const maxKeyLength = 128 - `workflow:${workflowName}:`.length;
  if (!key || key.length > maxKeyLength || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error(`Invalid idempotency key ${JSON.stringify(key)}: use 1-${maxKeyLength} chars of [A-Za-z0-9._:-]`);
  }
  return key;
}

function resolveWorkflowFile(workflowDir: string, rel: string) {
  const full = isAbsolute(rel) ? resolve(rel) : resolve(workflowDir, rel);
  const local = relative(workflowDir, full);
  if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
    throw new Error(`Workflow file path escapes workflow directory: ${rel}`);
  }
  return full;
}

export type CreateWorkflowContextInput = {
  workflow: ResolvedWorkflow;
  task: Task;
  run: Run;
  subject: Subject;
  references: EventReferences;
  repositoryPath: string;
  log: Logger;
  signal: AbortSignal;
  dryRun: boolean;
  trigger: WorkflowContext["trigger"];
  onWorkspaceAcquired?: (workspace: { id: string; path: string }) => void;
  onWorkspaceReleased?: () => void;
};

export function createWorkflowContext(input: CreateWorkflowContextInput): { ctx: WorkflowContext; hasPublishedEffects: () => boolean } {
  const { workflow, task, run, subject, references, repositoryPath, log, signal, dryRun, trigger } = input;
  const github = new GitHubRepository(subject.repository);
  const usedStepNames = new Set<string>();
  const inFlightEffects = new Set<string>();
  let checkoutActive = false;
  const dryRunState = new Map<string, { v: unknown } | undefined>();
  let published = false;

  async function writeDryRunPreview(kind: string, key: string, payload: Record<string, unknown>) {
    const dir = resolve("data/workflow-dry-runs", `${workflow.name}-${run.id.slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    const safeFile = `${kind}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const file = join(dir, safeFile);
    await writeFile(file, JSON.stringify({ workflow: workflow.name, runId: run.id, kind, key, ...payload }, null, 2) + "\n", "utf8");
    log.info({ event: "workflow.dry_run_effect", workflow: workflow.name, kind, key, previewPath: file });
    return file;
  }

  const findStep = (name: string) => db.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.name, name))).get();

  async function recordStep<T>(name: string, inputHash: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    db.insert(steps).values({
      taskId: task.id,
      name,
      inputHash,
      workflowHash: workflow.hash,
      status: "running",
      output: null,
      error: null,
      startedAt,
      finishedAt: null,
    }).onConflictDoUpdate({
      target: [steps.taskId, steps.name],
      set: { inputHash, workflowHash: workflow.hash, status: "running", output: null, error: null, startedAt, finishedAt: null },
    }).run();
    log.info({ event: "workflow.step_started", workflow: workflow.name, step: name });
    try {
      const rawOutput = await fn();
      const output = ensureJsonSerializable(`Step ${name} output`, rawOutput);
      const finishedAt = new Date().toISOString();
      db.update(steps).set({ status: "completed", output, error: null, finishedAt })
        .where(and(eq(steps.taskId, task.id), eq(steps.name, name))).run();
      log.info({ event: "workflow.step_completed", workflow: workflow.name, step: name, durationMs: Math.round(performance.now() - startedMs) });
      return output;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      db.update(steps).set({ status: "failed", error: describeError(error), finishedAt })
        .where(and(eq(steps.taskId, task.id), eq(steps.name, name))).run();
      log.warn({ event: "workflow.step_failed", workflow: workflow.name, step: name, durationMs: Math.round(performance.now() - startedMs), err: error });
      throw error;
    }
  }

  async function runStep<T>(name: string, stepInput: unknown, fn: () => Promise<T>): Promise<T> {
    assertNotAborted(signal, `step ${name}`);
    if (!name.trim()) throw new Error("Step name must be non-empty");
    if (name.startsWith(effectPrefix)) throw new Error(`Step name must not start with ${effectPrefix}: ${name}`);
    if (usedStepNames.has(name)) throw new Error(`Duplicate workflow step name in run: ${name}`);
    usedStepNames.add(name);
    const inputHash = hashJson(stepInput ?? null);
    const existing = findStep(name);
    if (existing && existing.status === "completed" && existing.inputHash === inputHash && existing.workflowHash === workflow.hash) {
      log.info({ event: "workflow.step_replayed", workflow: workflow.name, step: name });
      return existing.output as T;
    }
    return recordStep(name, inputHash, fn);
  }

  function isConfirmedSlackRejection(error: unknown) {
    if (error instanceof SecretLeakError) return true;
    if (error && typeof error === "object" && typeof (error as { slackError?: unknown }).slackError === "string") return true;
    if (error instanceof Error) {
      if (error.message.includes("SLACK_BOT_TOKEN is not set")) return true;
      if (error.message.includes("was rate limited")) return true;
      if (/failed with HTTP 4\d\d\b/.test(error.message)) return true;
    }
    return false;
  }

  async function runEffectStep<T>(effect: string, key: string, effectInput: unknown, fn: () => Promise<T>, options: { replayOnInputChange?: boolean; uncertainVia?: string } = {}): Promise<T> {
    const name = `${effectPrefix}${effect}:${key}`;
    if (inFlightEffects.has(name)) {
      throw new Error(`Concurrent effect call with duplicate key: ${name}`);
    }
    const inputHash = hashJson(effectInput ?? null);
    const existing = findStep(name);
    if (existing?.status === "completed" && (options.replayOnInputChange || existing.inputHash === inputHash)) {
      log.info({ event: "workflow.effect_replayed", workflow: workflow.name, step: name });
      published = true;
      return existing.output as T;
    }
    if (existing?.status === "running" && options.uncertainVia) {
      throw new Error(`Uncertain ${options.uncertainVia} delivery for key ${key}: prior attempt started but did not confirm completion; verify in ${options.uncertainVia} before retrying`);
    }
    inFlightEffects.add(name);
    updateRun(run.id, { stage: "publishing" });
    let succeeded = false;
    try {
      let output: T;
      if (options.uncertainVia) {
        const startedAt = new Date().toISOString();
        const startedMs = performance.now();
        db.insert(steps).values({
          taskId: task.id,
          name,
          inputHash,
          workflowHash: workflow.hash,
          status: "running",
          output: null,
          error: null,
          startedAt,
          finishedAt: null,
        }).onConflictDoUpdate({
          target: [steps.taskId, steps.name],
          set: { inputHash, workflowHash: workflow.hash, status: "running", output: null, error: null, startedAt, finishedAt: null },
        }).run();
        log.info({ event: "workflow.step_started", workflow: workflow.name, step: name });
        try {
          const rawOutput = await fn();
          output = ensureJsonSerializable(`Step ${name} output`, rawOutput);
          db.update(steps).set({ status: "completed", output, error: null, finishedAt: new Date().toISOString() })
            .where(and(eq(steps.taskId, task.id), eq(steps.name, name))).run();
          log.info({ event: "workflow.step_completed", workflow: workflow.name, step: name, durationMs: Math.round(performance.now() - startedMs) });
        } catch (error) {
          const confirmed = isConfirmedSlackRejection(error);
          db.update(steps).set({
            status: confirmed ? "failed" : "running",
            error: describeError(error),
            finishedAt: confirmed ? new Date().toISOString() : null,
          }).where(and(eq(steps.taskId, task.id), eq(steps.name, name))).run();
          log.warn({ event: "workflow.step_failed", workflow: workflow.name, step: name, uncertain: !confirmed, durationMs: Math.round(performance.now() - startedMs), err: error });
          throw error;
        }
      } else {
        output = await recordStep(name, inputHash, fn);
      }
      succeeded = true;
      published = true;
      return output;
    } finally {
      inFlightEffects.delete(name);
      if (succeeded && inFlightEffects.size === 0) updateRun(run.id, { stage: "agent" });
    }
  }

  async function parallel<T extends Record<string, () => Promise<unknown>>>(entries: T) {
    assertNotAborted(signal, "parallel");
    const keys = Object.keys(entries) as (keyof T)[];
    const settled = await Promise.allSettled(keys.map((key) => Promise.resolve().then(() => entries[key]!())));
    const failed = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failed.length) {
      const superseded = failed.find((entry) => entry.reason instanceof SupersededError);
      if (superseded) throw superseded.reason;
      const interrupted = failed.find((entry) => entry.reason instanceof InterruptedError);
      if (interrupted) throw interrupted.reason;
      const transient = failed.find((entry) => errorCode(entry.reason) === transientInferenceCode);
      if (transient) throw transient.reason;
      throw failed[0]!.reason;
    }
    const out = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
    keys.forEach((key, index) => {
      out[key] = (settled[index] as PromiseFulfilledResult<Awaited<ReturnType<T[typeof key]>>>).value;
    });
    return out;
  }

  const readState = (key: string, database: Pick<typeof db, "select"> = db) => {
    if (dryRun && dryRunState.has(key)) return dryRunState.get(key);
    const row = database.select().from(workflowState).where(and(eq(workflowState.workflow, workflow.name), eq(workflowState.key, key))).get();
    return row ? { v: unwrapState(row.value) } : undefined;
  };

  const writeState = (key: string, value: unknown, database: Pick<typeof db, "insert"> = db) => {
    const envelope = { v: value };
    const updatedAt = new Date().toISOString();
    database.insert(workflowState).values({ workflow: workflow.name, key, value: envelope, updatedAt })
      .onConflictDoUpdate({ target: [workflowState.workflow, workflowState.key], set: { value: envelope, updatedAt } }).run();
  };

  const nextState = <T>(key: string, current: { v: unknown } | undefined, fn: (current: T | undefined) => T) => {
    const next = fn(current?.v as T | undefined);
    if (next instanceof Promise) throw new Error(`state.update(${key}) callback must be synchronous`);
    return ensureJsonSerializable(`state.${key}`, next);
  };

  const state: WorkflowContext["state"] = {
    get<T = unknown>(key: string) {
      assertNotAborted(signal, `state.get(${key})`);
      return readState(key)?.v as T | undefined;
    },
    set(key: string, value: unknown) {
      assertNotAborted(signal, `state.set(${key})`);
      const safe = ensureJsonSerializable(`state.${key}`, value);
      if (dryRun) {
        dryRunState.set(key, { v: safe });
        log.info({ event: "workflow.dry_run_state", workflow: workflow.name, key });
        return;
      }
      writeState(key, safe);
    },
    update<T>(key: string, fn: (current: T | undefined) => T) {
      assertNotAborted(signal, `state.update(${key})`);
      if (dryRun) {
        const next = nextState(key, readState(key), fn);
        dryRunState.set(key, { v: next });
        log.info({ event: "workflow.dry_run_state", workflow: workflow.name, key });
        return next;
      }
      return db.transaction((transaction): unknown => {
        const next = nextState(key, readState(key, transaction), fn);
        writeState(key, next, transaction);
        return next;
      }, { behavior: "immediate" }) as T;
    },
    delete(key: string) {
      assertNotAborted(signal, `state.delete(${key})`);
      if (dryRun) {
        dryRunState.set(key, undefined);
        return;
      }
      db.delete(workflowState).where(and(eq(workflowState.workflow, workflow.name), eq(workflowState.key, key))).run();
    },
  };

  const workspace: WorkflowContext["workspace"] = {
    baseBranch: config.github.baseBranch,
    async withCheckout<T>(ref: string, fn: (ws: WorkflowCheckout) => Promise<T>): Promise<T> {
      assertNotAborted(signal, "workspace.withCheckout");
      assertPermission<WorkspacePermission>(workflow.permissions.workspace, "read", "workspace", workflow.name);
      if (checkoutActive) {
        throw new Error("Overlapping workspace.withCheckout calls are not supported in a single workflow run");
      }
      checkoutActive = true;
      let ws: { id: string; path: string; baseSha: string } | undefined;
      try {
        const baseRef = await github.fetchBranch(ref);
        ws = await createWorkspace({ repositoryPath, baseRef }, references);
        updateRun(run.id, { workspaceId: ws.id, mainSha: ws.baseSha, headSha: ws.baseSha });
        input.onWorkspaceAcquired?.({ id: ws.id, path: ws.path });
        return await fn({ id: ws.id, path: ws.path, baseSha: ws.baseSha, ref });
      } finally {
        checkoutActive = false;
        if (ws) {
          input.onWorkspaceReleased?.();
          try {
            await removeWorkspace(ws.id, references);
          } catch (cleanupError) {
            log.warn({ err: cleanupError, workspaceId: ws.id }, "Failed to remove workflow workspace");
          }
        }
      }
    },
  };

  const agent: WorkflowContext["agent"] = {
    async run<T = Record<string, unknown>>(options: WorkflowAgentOptions): Promise<WorkflowAgentResult<T>> {
      assertNotAborted(signal, "agent.run");
      const skillFile = options.skill
        ? resolveWorkflowFile(workflow.dir, options.skill)
        : workflow.skillPath;
      if (!skillFile) throw new Error(`Workflow ${workflow.name} has no SKILL.md and no skill option was provided`);
      const contextDir = await mkdtemp(join(tmpdir(), `scrat-wf-${workflow.name}-`));
      try {
        const effectiveTools = options.tools ?? workflow.defaults.tools;
        for (const tool of effectiveTools) {
          if (!allowedToolSet.has(tool)) {
            throw new Error(`Workflow ${workflow.name} requested disallowed tool "${tool}"`);
          }
        }
        if (effectiveTools.includes("github_search")) {
          assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
        }
        let contextText = options.context ?? "";
        if (options.input !== undefined) {
          const inputPath = join(contextDir, "input.json");
          const serialized = JSON.stringify(options.input, null, 2);
          await writeFile(inputPath, serialized + "\n", "utf8");
          const bytes = Buffer.byteLength(serialized, "utf8");
          const inline = bytes <= config.context.historyBytes;
          if (!inline && !effectiveTools.includes("read")) {
            throw new Error(`Workflow ${workflow.name} input (${bytes} bytes) exceeds context.historyBytes (${config.context.historyBytes}) but agent tools do not include "read"`);
          }
          contextText = [
            contextText,
            inline
              ? `## Workflow input\n\n\`\`\`json\n${serialized}\n\`\`\``
              : `## Workflow input\n\nFull JSON input is staged at \`${inputPath}\` (${bytes} bytes). Read or filter it with \`codemode\` or \`read\`.`,
          ].filter(Boolean).join("\n\n");
        }
        const effectiveRun: Run = {
          ...run,
          skill: skillFile,
          provider: options.provider ?? workflow.defaults.provider,
          model: options.model ?? workflow.defaults.model,
          thinkingLevel: options.thinkingLevel ?? workflow.defaults.thinkingLevel,
        };
        let sessionInfo: { id?: string; file?: string } = {};
        const res = await executePi({
          run: effectiveRun,
          cwd: options.cwd,
          tools: effectiveTools,
          scoped: { mode: "review", codemode: options.codemode ?? workflow.defaults.codemode },
          contextDir,
          log: log.child({ workflow: workflow.name, model: effectiveRun.model }),
          stop: signal,
        }, {
          context: contextText,
          skillPath: skillFile,
          submitResult: options.submitResult,
          onSession: (details) => {
            sessionInfo = { id: details.piSessionId, file: details.piSessionFile };
            updateRun(run.id, { piSessionId: details.piSessionId, piSessionFile: details.piSessionFile });
          },
        });
        return {
          text: res.text,
          data: res.data as T | undefined,
          outcome: res.outcome,
          paths: res.paths,
          sessionId: sessionInfo.id,
          sessionFile: sessionInfo.file,
        };
      } finally {
        await rm(contextDir, { recursive: true, force: true });
      }
    },
  };

  const githubHelper: WorkflowContext["github"] = {
    async listOpenItems() {
      assertNotAborted(signal, "github.listOpenItems");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      return github.fetchOpenItems();
    },
    async listOpenIssues() {
      assertNotAborted(signal, "github.listOpenIssues");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      const { issues } = await github.fetchOpenItems();
      return issues;
    },
    async listOpenPrs() {
      assertNotAborted(signal, "github.listOpenPrs");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      const { pullRequests } = await github.fetchOpenItems();
      return pullRequests;
    },
    async listRecentMergedPrs(sinceDays, limit) {
      assertNotAborted(signal, "github.listRecentMergedPrs");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      return github.fetchRecentMergedPullRequests(sinceDays, limit);
    },
    async comment({ key, number, body }) {
      assertNotAborted(signal, "github.comment");
      assertPermission<GithubPermission>(workflow.permissions.github, "comment", "github", workflow.name);
      const safeKey = safeIdempotencyKey(key, workflow.name);
      assertPublishable(body);
      if (dryRun) {
        const previewPath = await writeDryRunPreview("github-comment", safeKey, { number, body });
        return { commentId: 0, dryRun: true, previewPath };
      }
      return runEffectStep("github.comment", safeKey, { number, body }, async () => {
        const marker = `<!-- scrat-workflow:${workflow.name}:${safeKey} -->`;
        const ctx = await github.fetchItemContext("issue", number);
        const existing = ctx.comments.findLast((candidate) => isBotLogin(candidate.author) && isIssueComment(candidate) && endsWithMarker(candidate.body, marker));
        const commentId = await upsertComment(github, number, existing, withMarker(body, marker), references);
        return { commentId };
      });
    },
    async issue({ key, title, body, labels }) {
      assertNotAborted(signal, "github.issue");
      assertPermission<GithubPermission>(workflow.permissions.github, "issue", "github", workflow.name);
      const safeKey = safeIdempotencyKey(key, workflow.name);
      const fingerprint = `workflow:${workflow.name}:${safeKey}`;
      assertPublishable(title, body, fingerprintMarker(fingerprint));
      if (dryRun) {
        const previewPath = await writeDryRunPreview("github-issue", safeKey, { title, body, labels: labels ?? [], fingerprint });
        return { number: 0, created: false, dryRun: true, previewPath };
      }
      return runEffectStep("github.issue", safeKey, { title, body, labels: labels ?? [] }, async () => {
        const { issues: open } = await github.fetchOpenItems();
        const marker = fingerprintMarker(fingerprint);
        const existing = open.find((candidate) => isBotLogin(candidate.user?.login) && endsWithMarker(candidate.body ?? "", marker));
        if (existing) return { number: existing.number, created: false };
        const created = await github.createIssue({ title, body, fingerprint, labels }, references);
        return { number: created.number, created: true };
      }, { replayOnInputChange: true });
    },
  };

  const slackHelper: WorkflowContext["slack"] = {
    async post({ key, channel, text, threadTs }) {
      assertNotAborted(signal, "slack.post");
      assertPermission<SlackPermission>(workflow.permissions.slack, "post", "slack", workflow.name);
      const safeKey = safeIdempotencyKey(key, workflow.name);
      assertPublishable(text);
      if (dryRun) {
        const previewPath = await writeDryRunPreview("slack-post", safeKey, { channel, text, threadTs });
        return { ts: "dry-run", dryRun: true, previewPath };
      }
      return runEffectStep("slack.post", safeKey, { channel, text, threadTs }, async () => {
        const ts = await postMessage({ channel, text, threadTs });
        return { ts };
      }, { replayOnInputChange: true, uncertainVia: "Slack" });
    },
  };

  return {
    ctx: {
      workflow: { name: workflow.name, dir: workflow.dir, hash: workflow.hash, dryRun, config: workflow.config },
      trigger,
      signal,
      log,
      step: runStep,
      parallel,
      state,
      workspace,
      agent,
      github: githubHelper,
      slack: slackHelper,
    },
    hasPublishedEffects: () => published,
  };
}
