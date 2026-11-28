import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { buildItemAgentInput, contextDirOf, evaluateItemContext, readDiffScope } from "./agent-input.ts";
import { embedRunScreenshots, type UploadedImage, uploadCloudflareImage } from "./cloudflare-images.ts";
import { findBotFingerprintedIssue, findBotMarkedComment, upsertComment } from "./comments.ts";
import { config } from "./config.ts";
import { type D1ExtractAnswer, type D1ExtractFieldSpec, extractFields, isD1Available, scoreDecisions } from "./d1.ts";
import { db } from "./db.ts";
import { describeError, errorCode, SupersededError, transientInferenceCode } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { git } from "./git.ts";
import { botName, botSlug } from "./identity.ts";
import { compareLighthouseSummaries, type LighthouseComparison, type LighthouseOptions, runStorefrontLighthouse, type StorefrontLighthouseSummary } from "./lighthouse.ts";
import { GitHubRepository } from "./github.ts";
import type { GithubContext, GithubIssue, GithubPullRequest } from "./github-types.ts";
import { categoriesFor, itemLabelKey } from "./item-labels.ts";
import type { Item } from "./items.ts";
import { reconcileLabels } from "./labels.ts";
import { effectNames, startEffectNames, type LabelCategory, type ThinkingLevel, type ToolName } from "./manifests.ts";
import { advisoryResolvedMarker, fingerprintMarker, withMarker, workflowCommentMarker } from "./markers.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { executePi, type SubmitResultSpec } from "./pi.ts";
import { assertComplete, hasPublicationSnapshot, InterruptedError, SecretLeakError, validateLabelSelections } from "./results.ts";
import { retainReviewScope } from "./review-paths.ts";
import { getRun, latestCompletedRun, updateRun } from "./run-history.ts";
import { steps, workflowState, type Run, type Subject, type Task } from "./schema.ts";
import type { BrowserScope } from "./scoped-tools.ts";
import { assertPublishable, childEnvironment } from "./secrets.ts";
import { postMessage } from "./slack.ts";
import { previewOfPr } from "./storefront.ts";
import { readSiteMap } from "./storefront-site.ts";
import { parseTriggerInput } from "./triggers.ts";
import {
  type GithubPermission, hashJson, isAdvisory, type ResolvedWorkflow, type SlackPermission, workflowAllowedTools,
  workflowItemLabelSettings, type WorkflowPipelineSpec, type WorkspacePermission,
} from "./workflows.ts";
import { createWorkspace, removeWorkspace } from "./workspaces.ts";

export type { D1ExtractAnswer, D1ExtractFieldSpec };

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
  browserSteps?: number;
  browserSeconds?: number;
};

type WorkflowAgentResult<T = Record<string, unknown>> = {
  text: string;
  data?: T;
  outcome: "complete" | "incomplete" | "needs_decision";
  ready: boolean;
  labels?: Array<{ category: string; name: string }>;
  paths: string[];
  sessionId?: string;
  sessionFile?: string;
};

type WorkflowPipelineOutcome = { skipped?: string; cancelled?: string; published?: boolean };
export type WorkflowPipelineRunner = (spec: WorkflowPipelineSpec, dryRun: boolean) => Promise<WorkflowPipelineOutcome>;

type WorkflowItemObserved = {
  context: GithubContext;
  observation: ItemObservation;
  pullRequest?: GithubPullRequest;
  mainSha: string;
};

type WorkflowItemCheckout = {
  id: string;
  path: string;
  branch: string | null;
  mainSha: string;
  headSha: string;
  diffBaseSha: string;
  diffPaths: string[];
  evaluated: NonNullable<Run["context"]>;
  observed: WorkflowItemObserved;
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
    kind: "cron" | "manual" | "event";
    manual: boolean;
    input: Record<string, unknown>;
    start?: string;
    end?: string;
    item?: { id: string; kind: "issue" | "pr"; number: number; title: string };
  };
  bot: { name: string; slug: string };
  storefront: {
    enabled: boolean;
    liveUrl: string | null;
    publicHost: string;
    devices: readonly string[];
    siteMap: () => Promise<string | undefined>;
    previewOfPr: (prNumber: number) => { url: string | null; themeId: number | null; headSha: string | null; available: boolean; problems: string[] } | undefined;
    lighthouse: (options?: LighthouseOptions) => Promise<StorefrontLighthouseSummary>;
    compareLighthouse: (before: StorefrontLighthouseSummary, after: StorefrontLighthouseSummary) => LighthouseComparison;
  };
  media: {
    enabled: boolean;
    uploadImage: (path: string) => Promise<UploadedImage | undefined>;
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
  d1: {
    enabled: boolean;
    score: (args: {
      state: string;
      questions: Record<string, string>;
      timeoutMs?: number;
    }) => Promise<{ ok: true; scores: Record<string, number>; d1Ms: number } | { ok: false; reason: string; d1Ms: number }>;
    extract: (args: {
      state: string;
      fields: Record<string, D1ExtractFieldSpec>;
      timeoutMs?: number;
    }) => Promise<{ ok: true; answers: Record<string, D1ExtractAnswer>; d1Ms: number } | { ok: false; reason: string; d1Ms: number }>;
  };
  github: {
    listOpenItems: () => Promise<{ issues: GithubIssue[]; pullRequests: GithubPullRequest[] }>;
    listOpenIssues: () => Promise<GithubIssue[]>;
    listOpenPrs: () => Promise<GithubPullRequest[]>;
    getPr: (number: number) => Promise<GithubPullRequest>;
    getIssue: (number: number) => Promise<GithubIssue>;
    listRecentMergedPrs: (sinceDays: number, limit?: number) => Promise<WorkflowMergedPr[]>;
    comment: (args: { key: string; number: number; body: string; resolved?: boolean }) => Promise<{ commentId: number; dryRun?: boolean; previewPath?: string }>;
    issue: (args: { key: string; title: string; body: string; labels?: string[] }) => Promise<{ number: number; created: boolean; dryRun?: boolean; previewPath?: string }>;
  };
  slack: {
    post: (args: { key: string; channel: string; text: string; threadTs?: string }) => Promise<{ ts: string; dryRun?: boolean; previewPath?: string }>;
  };
  item: {
    connect: () => Promise<WorkflowItemObserved>;
    observeTarget: (observed: WorkflowItemObserved) => void;
    assertExpectedTarget: (observed: WorkflowItemObserved) => void;
    assertLiveTarget: (observed: WorkflowItemObserved) => Promise<void>;
    ownComment: (observed: WorkflowItemObserved, key: string) => { body: string; resolved: boolean } | undefined;
    savedResult: () => { result: WorkflowAgentResult; labelingKey?: string } | undefined;
    labelCategories: () => LabelCategory[];
    labelKey: (observed: WorkflowItemObserved, categories: readonly LabelCategory[]) => string;
    skipAsUnchanged: (reason: string) => never;
    withCheckout: <T>(
      observed: WorkflowItemObserved,
      options: { prepare?: boolean; labelingCategories?: LabelCategory[] },
      fn: (ws: WorkflowItemCheckout) => Promise<T>,
    ) => Promise<T>;
    runAgent: (
      ws: WorkflowItemCheckout,
      options: {
        files: readonly string[];
        contextMode?: "all" | "change";
        labelCategories?: readonly LabelCategory[];
        skill?: string;
        tools?: readonly ToolName[];
        codemode?: boolean;
        submitResult?: SubmitResultSpec;
        browserSteps?: number;
        browserSeconds?: number;
      },
    ) => Promise<WorkflowAgentResult>;
    recordResult: (result: Pick<WorkflowAgentResult, "text" | "outcome" | "ready" | "labels" | "paths">) => void;
    assertLabelSelections: (labels: unknown, categories: readonly LabelCategory[]) => asserts labels is Array<{ category: string; name: string }>;
    assertFreshForPublication: (current: WorkflowItemObserved, options?: { labelKey?: string; labelCategories?: readonly LabelCategory[] }) => Promise<void>;
    reconcileLabels: (args: { key: string; current: WorkflowItemObserved; desired: string[]; managed: string[] }) => Promise<{ desired: string[]; dryRun?: boolean; previewPath?: string }>;
  };
  review: {
    run: (spec: Omit<WorkflowPipelineSpec, "acceptance" | "commitPrefix" | "acceptDecision">) => Promise<WorkflowPipelineOutcome>;
  };
  change: {
    run: (spec: Omit<WorkflowPipelineSpec, "agent" | "start">) => Promise<WorkflowPipelineOutcome>;
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

const allowedToolSet = new Set<string>([...workflowAllowedTools, "browser"]);
const validEffects = new Set<string>(effectNames);
const validStartEffects = new Set<string>(startEffectNames);

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
  item?: Item;
  references: EventReferences;
  repositoryPath: string;
  log: Logger;
  signal: AbortSignal;
  dryRun: boolean;
  trigger: WorkflowContext["trigger"];
  onWorkspaceAcquired?: (workspace: { id: string; path: string }) => void;
  onWorkspaceReleased?: () => void;
  onTargetObserved?: (target: string) => void;
  runPipeline?: WorkflowPipelineRunner;
  replay?: { frozen: ReadonlySet<string>; baseSha?: string };
};

export function createWorkflowContext(input: CreateWorkflowContextInput): { ctx: WorkflowContext; hasPublishedEffects: () => boolean; usedManagedPipeline: () => boolean } {
  const { workflow, task, run, subject, item, references, repositoryPath, log, signal, dryRun, trigger } = input;
  const github = new GitHubRepository(subject.repository);
  const usedStepNames = new Set<string>();
  const inFlightEffects = new Set<string>();
  let checkoutActive = false;
  const dryRunState = new Map<string, { v: unknown } | undefined>();
  let published = false;
  let managedPipelineUsed = false;
  let lighthouseRuns = 0;

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

  async function recordStep<T>(
    name: string,
    inputHash: string,
    fn: () => Promise<T>,
    onErrorStatus?: (error: unknown) => "failed" | "running",
  ): Promise<T> {
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
      const status = onErrorStatus?.(error) ?? "failed";
      const uncertain = status === "running";
      db.update(steps).set({
        status,
        error: describeError(error),
        finishedAt: uncertain ? null : new Date().toISOString(),
      }).where(and(eq(steps.taskId, task.id), eq(steps.name, name))).run();
      log.warn({ event: "workflow.step_failed", workflow: workflow.name, step: name, ...(onErrorStatus ? { uncertain } : {}), durationMs: Math.round(performance.now() - startedMs), err: error });
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
    if (existing && existing.status === "completed") {
      if (input.replay?.frozen.has(name)) {
        log.info({ event: "workflow.step_frozen", workflow: workflow.name, step: name, inputDrift: existing.inputHash !== inputHash });
        return existing.output as T;
      }
      if (existing.inputHash === inputHash && existing.workflowHash === workflow.hash) {
        log.info({ event: "workflow.step_replayed", workflow: workflow.name, step: name });
        return existing.output as T;
      }
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
      const output = await recordStep(
        name,
        inputHash,
        fn,
        options.uncertainVia ? (error) => (isConfirmedSlackRejection(error) ? "failed" : "running") : undefined,
      );
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

  async function withExclusiveCheckout<W extends { id: string; path: string }, V, R>(
    stage: string,
    overlapError: string,
    acquire: () => Promise<W>,
    describe: (ws: W) => Promise<V> | V,
    fn: (value: V) => Promise<R>,
  ): Promise<R> {
    assertNotAborted(signal, stage);
    assertPermission<WorkspacePermission>(workflow.permissions.workspace, "read", "workspace", workflow.name);
    if (checkoutActive) throw new Error(overlapError);
    checkoutActive = true;
    let acquired: W | undefined;
    let notified = false;
    try {
      acquired = await acquire();
      const value = await describe(acquired);
      input.onWorkspaceAcquired?.({ id: acquired.id, path: acquired.path });
      notified = true;
      return await fn(value);
    } finally {
      checkoutActive = false;
      if (acquired) {
        if (notified) input.onWorkspaceReleased?.();
        try {
          await removeWorkspace(acquired.id, references);
        } catch (cleanupError) {
          log.warn({ err: cleanupError, workspaceId: acquired.id }, "Failed to remove workflow workspace");
        }
      }
    }
  }

  function prepareScriptAgent(options: { skill?: string; tools?: readonly ToolName[]; provider?: string; model?: string; thinkingLevel?: ThinkingLevel; forbidReadBase?: boolean }) {
    const skillFile = options.skill ? resolveWorkflowFile(workflow.dir, options.skill) : workflow.skillPath;
    if (!skillFile) throw new Error(`Workflow ${workflow.name} has no SKILL.md and no skill option was provided`);
    const effectiveTools = options.tools ?? workflow.defaults.tools;
    for (const tool of effectiveTools) {
      if (!allowedToolSet.has(tool)) throw new Error(`Workflow ${workflow.name} requested disallowed tool "${tool}"`);
      if (options.forbidReadBase && tool === "read_base") {
        throw new Error(`Workflow ${workflow.name} requested "read_base" outside ctx.item.runAgent`);
      }
    }
    if (effectiveTools.includes("github_search")) {
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
    }
    const effectiveRun: Run = {
      ...run,
      skill: skillFile,
      provider: options.provider ?? workflow.defaults.provider,
      model: options.model ?? workflow.defaults.model,
      thinkingLevel: options.thinkingLevel ?? workflow.defaults.thinkingLevel,
    };
    return { effectiveTools, effectiveRun };
  }

  function scriptBrowser(tools: readonly ToolName[], budget: { browserSteps?: number; browserSeconds?: number }): BrowserScope | undefined {
    if (!tools.includes("browser")) return undefined;
    const storefront = config.storefront.enabled;
    const hosts = workflow.browser ?? (storefront ? { navigationHosts: "any" as const, resourceHosts: "any" as const } : undefined);
    if (!hosts) throw new Error(`Workflow ${workflow.name} requested the browser tool without a browser setting or an enabled storefront`);
    const fallback = storefront ? config.storefront.limits : { browserSteps: config.tools.browser.steps, browserSeconds: config.tools.browser.sessionSeconds };
    const [steps, seconds] = (["browserSteps", "browserSeconds"] as const).map((key) => {
      const value = budget[key] ?? workflow.config[key] ?? fallback[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`Workflow ${workflow.name} ${key} must be a positive integer`);
      return value;
    }) as [number, number];
    return { ...hosts, limits: { steps, milliseconds: seconds * 1000 } };
  }

  const workspace: WorkflowContext["workspace"] = {
    baseBranch: config.github.baseBranch,
    withCheckout<T>(ref: string, fn: (ws: WorkflowCheckout) => Promise<T>): Promise<T> {
      return withExclusiveCheckout(
        "workspace.withCheckout",
        "Overlapping workspace.withCheckout calls are not supported in a single workflow run",
        async () => {
          const baseRef = input.replay?.baseSha ?? await github.fetchBranch(ref);
          return createWorkspace({ repositoryPath, baseRef }, references);
        },
        (ws) => {
          updateRun(run.id, { workspaceId: ws.id, mainSha: ws.baseSha, headSha: ws.baseSha });
          return { id: ws.id, path: ws.path, baseSha: ws.baseSha, ref };
        },
        fn,
      );
    },
  };

  const agent: WorkflowContext["agent"] = {
    async run<T = Record<string, unknown>>(options: WorkflowAgentOptions): Promise<WorkflowAgentResult<T>> {
      assertNotAborted(signal, "agent.run");
      const { effectiveTools, effectiveRun } = prepareScriptAgent({ ...options, forbidReadBase: true });
      const browser = scriptBrowser(effectiveTools, options);
      const contextDir = await mkdtemp(join(tmpdir(), `scrat-wf-${workflow.name}-`));
      try {
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
        if (getRun(run.id)?.stage !== "publishing") updateRun(run.id, { stage: "agent" });
        let sessionInfo: { id?: string; file?: string } = {};
        const res = await executePi({
          run: effectiveRun,
          cwd: options.cwd,
          tools: effectiveTools,
          scoped: { mode: "review", codemode: options.codemode ?? workflow.defaults.codemode, browser },
          contextDir,
          log: log.child({ workflow: workflow.name, model: effectiveRun.model }),
          stop: signal,
        }, {
          context: contextText,
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
          ready: res.ready,
          labels: res.labels,
          paths: res.paths,
          sessionId: sessionInfo.id,
          sessionFile: sessionInfo.file,
        };
      } finally {
        await rm(contextDir, { recursive: true, force: true });
      }
    },
  };

  const d1Trace = { signal, log, caller: `workflow:${workflow.name}` };
  const d1: WorkflowContext["d1"] = {
    enabled: isD1Available(),
    async score({ state, questions, timeoutMs }) {
      assertNotAborted(signal, "d1.score");
      const res = await scoreDecisions({ state, questions, timeoutMs, ...d1Trace });
      assertNotAborted(signal, "d1.score result");
      return res;
    },
    async extract({ state, fields, timeoutMs }) {
      assertNotAborted(signal, "d1.extract");
      const res = await extractFields({ state, fields, timeoutMs, ...d1Trace });
      assertNotAborted(signal, "d1.extract result");
      return res;
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
    async getPr(number) {
      assertNotAborted(signal, "github.getPr");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      const { item: found } = await github.fetchItemContext("pr", number, { comments: false });
      if (!("head" in found)) throw new Error(`#${number} is not a pull request`);
      return found;
    },
    async getIssue(number) {
      assertNotAborted(signal, "github.getIssue");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      return (await github.fetchItemContext("issue", number, { comments: false, issueOnly: true })).item;
    },
    async listRecentMergedPrs(sinceDays, limit) {
      assertNotAborted(signal, "github.listRecentMergedPrs");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      return github.fetchRecentMergedPullRequests(sinceDays, limit);
    },
    async comment({ key, number, body, resolved = false }) {
      assertNotAborted(signal, "github.comment");
      assertPermission<GithubPermission>(workflow.permissions.github, "comment", "github", workflow.name);
      const safeKey = safeIdempotencyKey(key, workflow.name);
      assertPublishable(body);
      if (dryRun) {
        const previewPath = await writeDryRunPreview("github-comment", safeKey, { number, body, resolved });
        return { commentId: 0, dryRun: true, previewPath };
      }
      return runEffectStep("github.comment", safeKey, { number, body, resolved }, async () => {
        const marker = workflowCommentMarker(workflow.name, safeKey);
        const ctx = await github.fetchItemContext("issue", number);
        const existing = findBotMarkedComment(ctx.comments, marker);
        const embedded = await embedRunScreenshots(body, contextDirOf(run.id), { runId: run.id, references });
        const commentId = await upsertComment(github, number, existing, withMarker(embedded, ...resolved ? [advisoryResolvedMarker] : [], marker), references);
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
        const existing = findBotFingerprintedIssue(open, fingerprint);
        if (existing) return { number: existing.number, created: false };
        const created = await github.createIssue({ title, body: await embedRunScreenshots(body, contextDirOf(run.id), { runId: run.id, references }), fingerprint, labels }, references);
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

  function requireItem(): Item {
    if (!item) throw new Error(`Workflow ${workflow.name} called ctx.item on a non-item subject (${subject.kind})`);
    return item;
  }

  const itemHelper: WorkflowContext["item"] = {
    async connect() {
      assertNotAborted(signal, "item.connect");
      assertPermission<GithubPermission>(workflow.permissions.github, "read", "github", workflow.name);
      const currentItem = requireItem();
      const context = await github.fetchItemContext(currentItem.kind, currentItem.payload.number);
      if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
      const pullRequest = "head" in context.item ? context.item : undefined;
      const observation = observe(context);
      const mainSha = await github.fetchBranch(observation.baseBranch);
      if (pullRequest) input.onTargetObserved?.(`${pullRequest.head.sha}@${observation.baseBranch}`);
      return { context, observation, pullRequest, mainSha };
    },
    observeTarget(observed) {
      if (observed.pullRequest) input.onTargetObserved?.(`${observed.pullRequest.head.sha}@${observed.observation.baseBranch}`);
    },
    assertExpectedTarget(observed) {
      const key = trigger.input.triggerKey;
      if (typeof key !== "string" || !observed.pullRequest) return;
      let expected: unknown;
      try { expected = JSON.parse(key); } catch { return; }
      if (!expected || typeof expected !== "object" || !("head" in expected) || !("base" in expected)) return;
      if (expected.head !== observed.pullRequest.head.sha || expected.base !== observed.observation.baseBranch) {
        throw new SupersededError("PR head or base moved after routing");
      }
    },
    async assertLiveTarget(observed) {
      assertNotAborted(signal, "item.assertLiveTarget");
      if (dryRun || requireItem().kind !== "pr" || !observed.pullRequest) return;
      const { item: live } = await github.fetchItemContext("pr", observed.pullRequest.number, { comments: false });
      if (!("head" in live) || live.head.sha !== observed.pullRequest.head.sha || live.base.ref !== observed.observation.baseBranch) {
        throw new SupersededError("PR head or base moved before publication");
      }
    },
    ownComment(observed, key) {
      const existing = findBotMarkedComment(observed.context.comments, workflowCommentMarker(workflow.name, safeIdempotencyKey(key, workflow.name)));
      return existing && { body: existing.body, resolved: existing.body.includes(advisoryResolvedMarker) };
    },
    savedResult() {
      if (!hasPublicationSnapshot(run)) return undefined;
      return {
        result: {
          text: run.result.text,
          outcome: run.result.outcome,
          ready: run.result.ready,
          labels: run.result.labels,
          paths: run.result.paths,
          sessionId: run.piSessionId ?? undefined,
          sessionFile: run.piSessionFile ?? undefined,
        },
        labelingKey: run.context.labeling?.key,
      };
    },
    labelCategories() {
      const currentItem = requireItem();
      return categoriesFor(workflowItemLabelSettings(workflow), currentItem.kind);
    },
    labelKey(observed, categories) {
      return itemLabelKey(observed.observation.item, categories);
    },
    skipAsUnchanged(reason) {
      throw new SupersededError(reason);
    },
    withCheckout<T>(observed: WorkflowItemObserved, options: { prepare?: boolean; labelingCategories?: LabelCategory[] }, fn: (ws: WorkflowItemCheckout) => Promise<T>): Promise<T> {
      let headSha = "";
      let evaluated: NonNullable<Run["context"]>;
      let diffBaseSha = "";
      let diffPaths: string[] = [];
      return withExclusiveCheckout(
        "item.withCheckout",
        "Overlapping workspace checkout calls are not supported in a single workflow run",
        async () => {
          const hasCommit = (sha: string) => git(repositoryPath, ["cat-file", "-e", `${sha}^{commit}`],
            { ...childEnvironment(), GIT_NO_LAZY_FETCH: "1" }).then(() => true, () => false);
          if (input.replay && !await hasCommit(observed.mainSha)) {
            await github.fetchBranch(observed.observation.baseBranch);
            if (!await hasCommit(observed.mainSha)) throw new Error(`Frozen base commit ${observed.mainSha} is unavailable`);
          }
          const pr = observed.pullRequest;
          headSha = !pr ? observed.mainSha : input.replay && await hasCommit(pr.head.sha) ? pr.head.sha : await github.fetchPullRequestHead(pr);
          if (observed.pullRequest) input.onTargetObserved?.(`${headSha}@${observed.observation.baseBranch}`);
          evaluated = evaluateItemContext(run, observed.observation, { labelCategories: options.labelingCategories });
          ({ diffBaseSha, diffPaths } = await readDiffScope(repositoryPath, observed.mainSha, headSha, Boolean(observed.pullRequest)));
          return createWorkspace({ repositoryPath, baseRef: headSha }, references);
        },
        (ws) => {
          updateRun(run.id, { workspaceId: ws.id, mainSha: observed.mainSha, headSha, context: evaluated });
          if (!options.prepare) {
            log.info({ event: "workspace.prepare_skipped", reason: options.labelingCategories ? "item labeling" : "issue review" });
          }
          return {
            id: ws.id,
            path: ws.path,
            branch: ws.branch,
            mainSha: observed.mainSha,
            headSha,
            diffBaseSha,
            diffPaths,
            evaluated,
            observed,
          };
        },
        fn,
      );
    },
    async runAgent(ws, options) {
      assertNotAborted(signal, "item.runAgent");
      const currentItem = requireItem();
      const { effectiveTools, effectiveRun } = prepareScriptAgent({ skill: options.skill, tools: options.tools });
      const browser = scriptBrowser(effectiveTools, options);
      const changeContext = options.contextMode === "change";
      const baseSha = changeContext ? ws.diffBaseSha : undefined;
      if (effectiveTools.includes("read_base") && !baseSha) {
        throw new Error(`Workflow ${workflow.name} requested "read_base" without contextMode: "change"`);
      }
      const { prompt, contextDir, revisions, labelCategories } = await buildItemAgentInput({
        run,
        task,
        evaluated: ws.evaluated,
        diffBaseSha: ws.diffBaseSha,
        diffPaths: ws.diffPaths,
        mainSha: ws.mainSha,
        headSha: ws.headSha,
        baseRef: ws.mainSha,
        mergeInProgress: false,
        workspace: { path: ws.path, branch: ws.branch },
        files: options.files,
      });
      let sessionInfo: { id?: string; file?: string } = {};
      updateRun(run.id, { stage: "agent" });
      const res = await executePi({
        run: effectiveRun,
        cwd: ws.path,
        tools: effectiveTools,
        scoped: { mode: "review", codemode: options.codemode ?? workflow.defaults.codemode, browser },
        baseSha,
        contextDir,
        revisions,
        environment: { ...config.workspace.environment },
        log: log.child({ workflow: workflow.name, model: effectiveRun.model }),
        stop: signal,
      }, {
        context: prompt,
        labelCategories: options.labelCategories ? [...options.labelCategories] : labelCategories,
        submitResult: options.submitResult,
        onSession: (details) => {
          sessionInfo = { id: details.piSessionId, file: details.piSessionFile };
          updateRun(run.id, { piSessionId: details.piSessionId, piSessionFile: details.piSessionFile });
        },
      });
      const combined = [...new Set([...ws.diffPaths, ...res.paths])];
      const parsedTrigger = parseTriggerInput(run.input);
      let retained = combined;
      if (parsedTrigger.kind === "item_changed" && !isAdvisory(workflow)) {
        const previous = latestCompletedRun(currentItem.id, workflow.name);
        if (previous && previous.context?.revision === ws.evaluated.revision) {
          retained = await retainReviewScope({
            repositoryPath,
            mainSha: ws.mainSha,
            headSha: ws.headSha,
            diffPaths: ws.diffPaths,
            paths: res.paths,
            previousMainSha: previous.mainSha,
            previousPaths: previous.result?.paths,
            changedPaths: parsedTrigger.changedPaths,
          });
        }
      }
      const finalResult = { ...res, paths: retained };
      updateRun(run.id, { result: finalResult, stage: "validating" });
      assertComplete(finalResult);
      updateRun(run.id, { stage: isAdvisory(workflow) ? "agent" : "publishing" });
      return {
        text: finalResult.text,
        data: res.data as Record<string, unknown> | undefined,
        outcome: finalResult.outcome,
        ready: finalResult.ready,
        labels: finalResult.labels,
        paths: finalResult.paths,
        sessionId: sessionInfo.id,
        sessionFile: sessionInfo.file,
      };
    },
    async assertFreshForPublication(current, options = {}) {
      assertNotAborted(signal, "item.assertFreshForPublication");
      const evaluatedRun = getRun(run.id)!;
      if (options.labelKey !== undefined && options.labelCategories) {
        if (itemLabelKey(current.observation.item, options.labelCategories) !== options.labelKey) {
          throw new Error("GitHub item changed or label policy changed; enqueue a fresh labeling task");
        }
        return;
      }
      const state = await freshness(savedEvaluation(evaluatedRun), { ...current.observation, mainSha: async () => github.fetchBranch(current.observation.baseBranch) }, "relevant-paths", true);
      if (state.kind === "stale") {
        throw new Error(state.reason === "context"
          ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
          : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
      }
    },
    async reconcileLabels({ key, current, desired, managed }) {
      assertNotAborted(signal, "item.reconcileLabels");
      assertPermission<GithubPermission>(workflow.permissions.github, "label", "github", workflow.name);
      const safeKey = safeIdempotencyKey(key, workflow.name);
      if (dryRun) {
        const previewPath = await writeDryRunPreview("github-labels", safeKey, { number: current.observation.item.number, desired, managed });
        return { desired, dryRun: true, previewPath };
      }
      return runEffectStep("github.labels", safeKey, { number: current.observation.item.number, desired, managed }, async () => {
        await reconcileLabels(github, current.observation.item.number, { current: current.observation.labels, desired, managed }, references);
        return { desired };
      });
    },
    recordResult(result) {
      assertNotAborted(signal, "item.recordResult");
      requireItem();
      const saved = { text: result.text, outcome: result.outcome, ready: result.ready, paths: [...result.paths], ...(result.labels ? { labels: result.labels } : {}) };
      updateRun(run.id, { result: saved, stage: "validating" });
      assertComplete(saved);
      updateRun(run.id, { stage: isAdvisory(workflow) ? "agent" : "publishing" });
    },
    assertLabelSelections(labels, categories) {
      validateLabelSelections(labels, categories);
    },
  };

  const runManaged = async (expectedMode: "review" | "change", spec: WorkflowPipelineSpec) => {
    assertNotAborted(signal, `${expectedMode}.run`);
    if (isAdvisory(workflow)) {
      throw new Error(`Workflow ${workflow.name} has role advisory and cannot call ctx.${expectedMode}.run()`);
    }
    if (workflow.mode !== expectedMode) {
      throw new Error(`Workflow ${workflow.name} has mode "${workflow.mode}" and cannot call ctx.${expectedMode}.run()`);
    }
    if (expectedMode === "change" && spec.publish[0] !== "push") {
      throw new Error(`Workflow ${workflow.name} change pipeline must publish "push" first`);
    }
    assertPermission<WorkspacePermission>(workflow.permissions.workspace, expectedMode === "change" ? "write" : "read", "workspace", workflow.name);
    const unknownEffects = [...(spec.start ?? []).filter((effect) => !validStartEffects.has(effect)), ...spec.publish.filter((effect) => !validEffects.has(effect))];
    if (unknownEffects.length) throw new Error(`Workflow ${workflow.name} requested unknown effects: ${unknownEffects.join(", ")}`);
    for (const effect of spec.start ?? []) {
      if (effect === "slack_post") assertPermission<SlackPermission>(workflow.permissions.slack, "post", "slack", workflow.name);
    }
    for (const effect of spec.publish) {
      if (effect === "comment") assertPermission<GithubPermission>(workflow.permissions.github, "comment", "github", workflow.name);
      else if (effect === "labels") assertPermission<GithubPermission>(workflow.permissions.github, "label", "github", workflow.name);
      else if (effect === "pr_assessment") {
        assertPermission<GithubPermission>(workflow.permissions.github, "comment", "github", workflow.name);
        assertPermission<GithubPermission>(workflow.permissions.github, "label", "github", workflow.name);
        if (workflow.on.event?.item !== "pr") throw new Error(`Workflow ${workflow.name} pr_assessment requires on.event.item: pr`);
      } else if (effect === "issue") assertPermission<GithubPermission>(workflow.permissions.github, "issue", "github", workflow.name);
      else if (effect === "push") assertPermission<GithubPermission>(workflow.permissions.github, "push", "github", workflow.name);
      else if (effect === "pull_request") assertPermission<GithubPermission>(workflow.permissions.github, "pull_request", "github", workflow.name);
      else if (effect === "slack_reply") assertPermission<SlackPermission>(workflow.permissions.slack, "post", "slack", workflow.name);
      else if (effect === "site_map" && workflow.on.event?.source !== "storefront") {
        throw new Error(`Workflow ${workflow.name} site_map requires on.event.source: storefront`);
      }
    }
    if (!input.runPipeline) {
      throw new Error(`Managed ${expectedMode} pipeline is not available in this execution context`);
    }
    managedPipelineUsed = true;
    const outcome = await input.runPipeline(spec, dryRun);
    if (outcome.published) published = true;
    return outcome;
  };

  return {
    ctx: {
      workflow: { name: workflow.name, dir: workflow.dir, hash: workflow.hash, dryRun, config: workflow.config },
      trigger,
      bot: { name: botName, slug: botSlug },
      storefront: {
        enabled: config.storefront.enabled,
        liveUrl: config.storefront.enabled && config.storefront.publicHost ? `https://${config.storefront.publicHost}` : null,
        publicHost: config.storefront.publicHost,
        devices: config.storefront.devices,
        siteMap: readSiteMap,
        previewOfPr: (prNumber) => previewOfPr(subject.repository, prNumber),
        compareLighthouse: compareLighthouseSummaries,
        async lighthouse(options = {}) {
          assertNotAborted(signal, "storefront.lighthouse");
          if (!config.storefront.enabled || !config.storefront.publicHost) throw new Error(`Workflow ${workflow.name} called ctx.storefront.lighthouse but the storefront is not enabled (storefront.enabled and storefront.publicHost)`);
          return runStorefrontLighthouse(`https://${config.storefront.publicHost}`, join(contextDirOf(run.id), `lighthouse-${++lighthouseRuns}`), references, signal, options);
        },
      },
      media: {
        enabled: config.media.cloudflareImages.enabled,
        async uploadImage(path) {
          assertNotAborted(signal, "media.uploadImage");
          return uploadCloudflareImage(resolve(contextDirOf(run.id), path), { contextDir: contextDirOf(run.id), runId: run.id, references });
        },
      },
      signal,
      log,
      step: runStep,
      parallel,
      state,
      workspace,
      agent,
      d1,
      github: githubHelper,
      slack: slackHelper,
      item: itemHelper,
      review: { run: (spec) => runManaged("review", spec) },
      change: { run: (spec) => runManaged("change", spec) },
    },
    hasPublishedEffects: () => published,
    usedManagedPipeline: () => managedPipelineUsed,
  };
}
