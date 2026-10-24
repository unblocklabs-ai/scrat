import { DrizzleQueryError } from "drizzle-orm";
import { RequestError } from "octokit";
import { secretValues } from "./secrets.ts";

export type ErrorDetails = {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  exitCode?: number;
  evidence?: string;
  stdout?: string;
  stderr?: string;
  requestId?: string;
  cause?: ErrorDetails;
};

export function redactSecrets(value: string) {
  for (const secret of secretValues()) value = value.replaceAll(secret, "[redacted]");
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bxox[bp]-[A-Za-z0-9-]{20,}/g, "[redacted]")
    .replace(/\b(Bearer|token)\s+\S+/gi, "$1 [redacted]");
}

export const transientInferenceCode = "TRANSIENT_INFERENCE";
export const branchConflictCode = "BRANCH_CONFLICT";

export function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function errorExitCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : undefined;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const ifMissing = <T, F>(promise: Promise<T>, fallback: F) => promise.catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; return fallback; });

export function errorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

export function describeError(error: unknown, seen = new Set<unknown>()): ErrorDetails {
  if (!(error instanceof Error)) {
    return { name: "Error", message: typeof error === "string" ? redactSecrets(error) : "Non-Error exception" };
  }
  if (seen.has(error)) return { name: "Error", message: "Circular error cause" };
  seen.add(error);
  const message = error instanceof DrizzleQueryError
    ? `Failed query: ${error.query}\nparams: [redacted]`
    : error.message;
  const requestId = error instanceof RequestError ? error.response?.headers["x-github-request-id"] : undefined;
  return {
    name: redactSecrets(error.name),
    message: redactSecrets(message),
    stack: error.stack ? redactSecrets(error.stack.replace(error.message, message)) : undefined,
    status: errorStatus(error),
    code: errorCode(error),
    exitCode: errorExitCode(error),
    evidence: "evidence" in error && typeof error.evidence === "string" ? error.evidence : undefined,
    stdout: "stdout" in error && typeof error.stdout === "string" ? redactSecrets(error.stdout) : undefined,
    stderr: "stderr" in error && typeof error.stderr === "string" ? redactSecrets(error.stderr) : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
    cause: error.cause === undefined ? undefined : describeError(error.cause, seen),
  };
}
