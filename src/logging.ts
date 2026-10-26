import { randomUUID } from "node:crypto";
import pino from "pino";
import { config } from "./config.ts";
import { describeError, redactSecrets } from "./errors.ts";

export const logger = pino({
  name: "scrat",
  level: config.harness.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: describeError,
    msg(value: unknown) {
      return typeof value === "string"
        ? redactSecrets(value)
        : value;
    },
  },
  redact: {
    paths: ["authorization", "headers.authorization", "request.headers.authorization", "token", "privateKey", "apiKey", "*.token", "*.privateKey", "*.apiKey"],
    censor: "[redacted]",
  },
}, pino.destination({ dest: 2, sync: true }));

export async function bestEffort<T>(log: typeof logger, event: string, fields: Record<string, unknown>, work: () => Promise<T>) {
  try { return await work(); }
  catch (err) { log.warn({ ...fields, event, err }); return undefined; }
}

export function startOperation(operation: string, context: Record<string, unknown> = {}) {
  const operationId = randomUUID();
  const log = logger.child({ ...context, operation, operationId });
  const startedAt = performance.now();
  log.info({ event: "operation.started" });
  return {
    operationId,
    log,
    complete(details: Record<string, unknown> = {}) {
      log.info({ ...details, event: "operation.completed", durationMs: Math.round(performance.now() - startedAt) });
    },
    fail(err: unknown, details: Record<string, unknown> = {}) {
      log.error({ ...details, event: "operation.failed", durationMs: Math.round(performance.now() - startedAt), err }, "Operation failed");
    },
  };
}

export type OperationScope = {
  operationId: string;
  log: typeof logger;
  stage(name: string): void;
  failure(details: Record<string, unknown>): void;
  complete(details?: Record<string, unknown>): void;
};

function beginOperation(name: string, context: Record<string, unknown>) {
  const operation = startOperation(name, context);
  let stage: string | undefined;
  let failure: Record<string, unknown> = {};
  const scope: OperationScope = {
    operationId: operation.operationId,
    log: operation.log,
    stage(next) { stage = next; },
    failure(details) { failure = { ...failure, ...details }; },
    complete: operation.complete,
  };
  return { scope, fail: (err: unknown) => operation.fail(err, { ...(stage === undefined ? {} : { stage }), ...failure }) };
}

export async function withOperation<T>(name: string, context: Record<string, unknown>, fn: (operation: OperationScope) => Promise<T>): Promise<T> {
  const { scope, fail } = beginOperation(name, context);
  try {
    return await fn(scope);
  } catch (error) {
    fail(error);
    throw error;
  }
}

export function withOperationSync<T>(name: string, context: Record<string, unknown>, fn: (operation: OperationScope) => T): T {
  const { scope, fail } = beginOperation(name, context);
  try {
    return fn(scope);
  } catch (error) {
    fail(error);
    throw error;
  }
}
