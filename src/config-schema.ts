import { type Static, Type } from "typebox";
import Value from "typebox/value";
import { modelSettings, nullable, retrySettings, thinkingLevels } from "./manifests.ts";

const strict = { additionalProperties: false } as const;
const open = { additionalProperties: true } as const;
const positive = Type.Integer({ minimum: 1 });

const schema = Type.Object({
  harness: Type.Object({
    maxConcurrency: positive, maxConcurrentValidations: positive, commandTimeoutSeconds: positive, commandOutputTailBytes: positive, maxOutputBytes: positive, gitNetworkTimeoutSeconds: positive, idlePollSeconds: positive, agentTimeoutSeconds: positive, drainTimeoutSeconds: positive, maxStderrBytes: positive, logTargetChars: positive, logErrorChars: positive, reviewCacheLimit: positive, treeCacheLimit: positive, databaseHealthRetries: positive,
    retryJitter: Type.Number({ minimum: 0, maximum: 1 }),
    corrections: Type.Object({ incomplete: Type.Integer({ minimum: 0 }), validation: Type.Integer({ minimum: 0 }), format: Type.Integer({ minimum: 0 }) }, strict),
    agentRetry: Type.Object({ maxRetries: Type.Integer({ minimum: 0 }), baseDelayMs: Type.Integer({ minimum: 0 }) }, strict),
    logLevel: Type.Enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  }, strict),
  github: Type.Object({
    repository: Type.String(), repositoryPath: Type.String(), baseBranch: Type.String(), auth: Type.Enum(["app", "pat"]), botLogin: Type.String(), botName: Type.String(),
    appId: positive, installationId: positive, fetchIntervalSeconds: positive, readConcurrency: positive, maxCachedResponses: positive, maxCachedChars: positive,
    rateLimitLowFraction: Type.Number({ minimum: 0, maximum: 1 }),
  }, strict),
  bindings: Type.Record(Type.String(), Type.Object({ secret: Type.String(), hosts: Type.Array(Type.String()), header: Type.String(), prefix: Type.Optional(Type.String()) }, strict)),
  context: Type.Object({ inlinePaths: positive, historyRuns: positive, historyBytes: positive }, strict),
  relevance: Type.Object({ ignoredPaths: Type.Array(Type.String()) }, strict),
  tools: Type.Object({
    readBytes: Type.Object({ default: positive, max: positive }, strict),
    git: Type.Object({ maxCommits: positive, maxScopeBytes: positive }, strict),
    http: Type.Object({ timeoutSeconds: positive, maxRequestBytes: positive }, strict),
    browser: Type.Object({ steps: positive, sessionSeconds: positive, stepSeconds: positive, defaultViewport: Type.String(), viewports: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), Type.Object({ width: positive, height: positive }, strict)) }, strict),
    search: Type.Object({ pageSize: positive, excerptChars: positive, maxQueryLength: positive }, strict),
    redactionMarginBytes: positive,
  }, strict),
  storefront: Type.Object({
    enabled: Type.Boolean(), store: Type.String(), publicHost: Type.String(),
    loggie: Type.Object({ url: Type.String(), slug: Type.String(), timeoutSeconds: positive }, strict),
    preview: Type.Object({
      themeNamePrefix: Type.String(), themePaths: Type.String(), processingWaitSeconds: positive, processingPollSeconds: positive,
      filesPageSize: Type.Integer({ minimum: 1, maximum: 250 }), uploadBatch: Type.Integer({ minimum: 1, maximum: 50 }), requestTimeoutSeconds: positive,
    }, strict),
  }, strict),
  slack: Type.Object({ enabled: Type.Boolean(), channel: Type.String(), maxRetryAfterSeconds: positive, minimumGapMs: Type.Integer({ minimum: 0 }), maxErrorLength: positive }, strict),
  workspace: Type.Object({
    sandbox: Type.Boolean(),
    commandMemoryMax: nullable(Type.String({ pattern: "^(?:[1-9]\\d*[KMGT]?|(?:100|[1-9]\\d?)%)$" })),
    packageStore: nullable(Type.String({ pattern: "^/" })),
    environment: Type.Record(Type.String(), Type.String()),
    prepare: Type.Array(Type.Array(Type.String())),
    database: nullable(Type.Object({ image: Type.String(), environment: Type.Array(Type.String()), migrate: Type.Array(Type.String()) }, strict)),
    validate: Type.Array(Type.Array(Type.String())),
    heavyCommands: Type.Array(Type.String()),
  }, strict),
  providers: Type.Record(Type.String(), Type.Object({
    baseUrl: Type.Optional(Type.String()), api: Type.Optional(Type.String()), apiKey: Type.Optional(Type.String()), authHeader: Type.Optional(Type.Boolean()),
    models: Type.Optional(Type.Array(Type.Object({
      id: Type.String(), name: Type.Optional(Type.String()), reasoning: Type.Optional(Type.Boolean()),
      thinkingLevelMap: Type.Optional(Type.Record(Type.String(), nullable(Type.String()))),
      contextWindow: Type.Optional(positive), maxTokens: Type.Optional(positive),
    }, open))),
  }, open)),
  actions: Type.Record(Type.String(), Type.Object({
    enabled: Type.Optional(Type.Boolean()), priority: Type.Integer(), skill: Type.String(), reviewers: Type.Array(modelSettings),
    branch: Type.Optional(Type.String()), channel: Type.Optional(Type.String()), maxRangeCommits: Type.Optional(positive), startMessage: Type.Optional(Type.String()),
    maxSelfRepairs: Type.Optional(Type.Integer({ minimum: 0 })), exhaustedLabel: Type.Optional(nullable(Type.String())), failedLabel: Type.Optional(nullable(Type.String())),
    provider: Type.String(), model: Type.String(), thinkingLevel: Type.Enum(thinkingLevels),
    retry: Type.Optional(nullable(retrySettings)),
  }, strict)),
}, strict);

export type ScratConfig = Static<typeof schema>;
export type ActionSettings = ScratConfig["actions"][string];

const dotted = (path: string) => path.slice(1).replaceAll("/", ".");
const where = (path: string, key: string) => [dotted(path), key].filter(Boolean).join(".");

export const configError = (problems: Iterable<string>) => new Error(`Invalid Scrat configuration:\n${[...problems].map((problem) => `- ${problem}`).join("\n")}`);

export function validateConfig(value: unknown): ScratConfig {
  if (Value.Check(schema, value)) return value;
  const problems = new Set<string>();
  for (const { keyword, instancePath, message, params } of Value.Errors(schema, value)) {
    if (keyword === "boolean" || keyword === "anyOf") continue;
    if (keyword === "additionalProperties") for (const key of (params as { additionalProperties: string[] }).additionalProperties) problems.add(`${where(instancePath, key)}: unknown setting`);
    else if (keyword === "required") for (const key of (params as { requiredProperties: string[] }).requiredProperties) problems.add(`${where(instancePath, key)}: required`);
    else problems.add(`${dotted(instancePath) || "config"}: ${message}`);
  }
  throw configError(problems);
}
