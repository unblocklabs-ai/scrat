import { config } from "./config.ts";
import { withOperation } from "./logging.ts";

type Reply<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; error?: { code?: string; message?: string } };

const failure = (message: string, code: string, status: number, data?: unknown) => Object.assign(new Error(message), { code, status, data });

export function loggie<T>(request: string, query: string, variables: Record<string, unknown> = {}, { stop, timeoutSeconds = config.storefront.loggie.timeoutSeconds }: { stop?: AbortSignal; timeoutSeconds?: number } = {}) {
  const { store, loggie: { url, slug } } = config.storefront;
  return withOperation("storefront.loggie", { store, request }, async (operation) => {
    const key = process.env.LOGGIE_API_KEY;
    if (!key) throw new Error("LOGGIE_API_KEY is not set");
    operation.stage("request");
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/proxy/${encodeURIComponent(slug)}/`, {
      method: "POST", redirect: "error", signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, variables }),
    });
    const reply = await response.json().catch(() => ({})) as Reply<T>;
    if (!response.ok || reply.error) {
      const code = reply.error?.code ?? "LOGGIE_HTTP";
      throw failure(`Loggie refused ${request} with HTTP ${response.status} ${code}${reply.error?.message ? `: ${reply.error.message}` : ""}`, code, response.status);
    }
    if (reply.errors?.length) {
      throw failure(`Shopify rejected ${request}: ${reply.errors.map((error) => error.message).join("; ")}`, reply.errors[0]!.extensions?.code ?? "GRAPHQL_ERROR", response.status, reply.data);
    }
    if (!reply.data) throw failure(`Loggie returned no data for ${request}`, "GRAPHQL_ERROR", response.status);
    operation.complete({ status: response.status });
    return reply.data;
  });
}
