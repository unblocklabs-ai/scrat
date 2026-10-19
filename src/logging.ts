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
        ? redactSecrets(value.replace(/(\nparams:)[\s\S]*/, "$1 [redacted]"))
        : value;
    },
  },
  redact: {
    paths: ["authorization", "headers.authorization", "request.headers.authorization", "token", "privateKey", "*.token", "*.privateKey"],
    censor: "[redacted]",
  },
}, pino.destination({ dest: 2, sync: true }));

export function startOperation(operation: string, context: Record<string, unknown> = {}) {
  const operationId = randomUUID();
  const log = logger.child({ ...context, parentOperationId: context.operationId, operation, operationId });
  const startedAt = performance.now();
  log.info({ event: "operation.started" });
  return {
    operationId,
    log,
    complete(details: Record<string, unknown> = {}) {
      log.info({ ...details, event: "operation.completed", durationMs: Math.round(performance.now() - startedAt) });
    },
    fail(err: unknown, details: Record<string, unknown> = {}) {
      log.error({ ...details, event: "operation.failed", durationMs: Math.round(performance.now() - startedAt), err });
    },
  };
}

process.on("uncaughtException", (err, origin) => {
  logger.fatal({ event: "process.uncaught_exception", origin, err });
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logger.fatal({ event: "process.unhandled_rejection", err });
  process.exit(1);
});
