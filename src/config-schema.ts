import { type Static, type TSchema, Type } from "typebox";
import Value from "typebox/value";
import { thinkingLevels } from "./manifests.ts";

const strict = { additionalProperties: false } as const;
const open = { additionalProperties: true } as const;
const positive = Type.Integer({ minimum: 1 });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const model = Type.Object({ provider: Type.String(), model: Type.String(), thinkingLevel: Type.Enum(thinkingLevels) }, strict);

const schema = Type.Object({
  harness: Type.Object({
    maxConcurrency: positive, maxConcurrentValidations: positive, commandTimeoutSeconds: positive, agentTimeoutSeconds: positive, drainTimeoutSeconds: positive,
    corrections: Type.Object({ incomplete: Type.Integer({ minimum: 0 }) }, strict),
    logLevel: Type.Enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  }, strict),
  github: Type.Object({
    repository: Type.String(), repositoryPath: Type.String(), baseBranch: Type.String(), auth: Type.Enum(["app", "pat"]), botLogin: Type.String(), botName: Type.String(),
    appId: positive, installationId: positive, fetchIntervalSeconds: positive,
  }, strict),
  bindings: Type.Record(Type.String(), Type.Object({ secret: Type.String(), hosts: Type.Array(Type.String()), header: Type.String(), prefix: Type.Optional(Type.String()) }, strict)),
  slack: Type.Object({ enabled: Type.Boolean(), channel: Type.String() }, strict),
  workspace: Type.Object({
    sandbox: Type.Optional(Type.Boolean()),
    commandMemoryMax: Type.Optional(nullable(Type.String({ pattern: "^(?:[1-9]\\d*[KMGT]?|(?:100|[1-9]\\d?)%)$" }))),
    packageStore: Type.Optional(nullable(Type.String({ pattern: "^/" }))),
    layout: Type.Optional(Type.Enum(["worktree", "clone"])),
    environment: Type.Optional(Type.Record(Type.String(), Type.String())),
    prepare: Type.Optional(Type.Array(Type.Array(Type.String()))),
    database: Type.Optional(nullable(Type.Object({ image: Type.String(), environment: Type.Array(Type.String()), migrate: Type.Array(Type.String()) }, strict))),
    validate: Type.Optional(Type.Array(Type.Array(Type.String()))),
    heavyCommands: Type.Optional(Type.Array(Type.String())),
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
    enabled: Type.Optional(Type.Boolean()), priority: Type.Integer(), skill: Type.String(), agent: Type.Enum(["single", "panel"]), reviewers: Type.Optional(Type.Array(model)),
    branch: Type.Optional(Type.String()), channel: Type.Optional(Type.String()), maxRangeCommits: Type.Optional(positive), startMessage: Type.Optional(Type.String()),
    maxSelfRepairs: Type.Optional(Type.Integer({ minimum: 0 })), exhaustedLabel: Type.Optional(nullable(Type.String())),
    provider: Type.String(), model: Type.String(), thinkingLevel: Type.Enum(thinkingLevels),
  }, strict)),
}, strict);

export type ScratConfig = Static<typeof schema>;
export type ActionSettings = ScratConfig["actions"][string];

const dotted = (path: string) => path.slice(1).replaceAll("/", ".");
const where = (path: string, key: string) => [dotted(path), key].filter(Boolean).join(".");

export function validateConfig(value: unknown): ScratConfig {
  if (Value.Check(schema, value)) return value;
  const problems = new Set<string>();
  for (const { keyword, instancePath, message, params } of Value.Errors(schema, value)) {
    if (keyword === "boolean" || keyword === "anyOf") continue;
    if (keyword === "additionalProperties") for (const key of (params as { additionalProperties: string[] }).additionalProperties) problems.add(`${where(instancePath, key)}: unknown setting`);
    else if (keyword === "required") for (const key of (params as { requiredProperties: string[] }).requiredProperties) problems.add(`${where(instancePath, key)}: required`);
    else problems.add(`${dotted(instancePath) || "config"}: ${message}`);
  }
  throw new Error(`Invalid Scrat configuration:\n${[...problems].map((problem) => `- ${problem}`).join("\n")}`);
}
