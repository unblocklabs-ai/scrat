import { config } from "./config.ts";
import { withOperation } from "./logging.ts";

type Reply<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; error?: { code?: string; message?: string } };

export class LoggieError extends Error {
  override readonly name = "LoggieError";
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function loggie<T>(request: string, query: string, variables: Record<string, unknown> = {}) {
  const { store, loggie: { url, slug, timeoutSeconds } } = config.storefront;
  return withOperation("storefront.loggie", { store, request }, async (operation) => {
    const key = process.env.LOGGIE_API_KEY;
    if (!key) throw new Error("LOGGIE_API_KEY is not set");
    operation.stage("request");
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/proxy/${encodeURIComponent(slug)}/`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutSeconds * 1000),
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, variables }),
    });
    const reply = await response.json().catch(() => ({})) as Reply<T>;
    if (!response.ok || reply.error) {
      const code = reply.error?.code ?? "LOGGIE_HTTP";
      throw new LoggieError(`Loggie refused ${request} with HTTP ${response.status} ${code}${reply.error?.message ? `: ${reply.error.message}` : ""}`, code, response.status);
    }
    if (reply.errors?.length) {
      throw new LoggieError(`Shopify rejected ${request}: ${reply.errors.map((error) => error.message).join("; ")}`, reply.errors[0]!.extensions?.code ?? "GRAPHQL_ERROR", response.status);
    }
    if (!reply.data) throw new LoggieError(`Loggie returned no data for ${request}`, "GRAPHQL_ERROR", response.status);
    operation.complete({ status: response.status });
    return reply.data;
  });
}
