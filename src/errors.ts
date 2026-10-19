export function describeError(error: unknown) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (!(cause instanceof Error)) return { name: "Error", message: "Unknown error" };
  let message = cause.message;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (privateKey) message = message.replaceAll(privateKey, "[redacted]");
  message = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:gh[oprsu]_|github_pat_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\b(Bearer|token)\s+\S+/gi, "$1 [redacted]");
  return {
    name: cause.name,
    message,
    status: "status" in cause && typeof cause.status === "number" ? cause.status : undefined,
    code: "code" in cause && typeof cause.code === "string" ? cause.code : undefined,
  };
}
