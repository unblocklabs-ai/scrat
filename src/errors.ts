import { DrizzleQueryError } from "drizzle-orm";
import { RequestError } from "octokit";

export type ErrorDetails = {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  requestId?: string;
  cause?: ErrorDetails;
};

export function redactSecrets(value: string) {
  for (const secret of [process.env.GITHUB_APP_PRIVATE_KEY, process.env.CODEX_LB_API_KEY]) {
    if (secret) value = value.replaceAll(secret, "[redacted]");
  }
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\b(Bearer|token)\s+\S+/gi, "$1 [redacted]");
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
    status: "status" in error && typeof error.status === "number" ? error.status : undefined,
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
    cause: error.cause === undefined ? undefined : describeError(error.cause, seen),
  };
}
