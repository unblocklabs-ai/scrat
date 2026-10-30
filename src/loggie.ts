import { config } from "./config.ts";
import { withOperation } from "./logging.ts";

type Reply<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; error?: { code?: string; message?: string } };
export type LoggieTarget = { url: string; slug: string; timeoutSeconds: number };
type Call = { path?: string; method?: "GET" | "POST"; body?: unknown; stop?: AbortSignal };

export const failure = (message: string, code: string, status: number, data?: unknown) => Object.assign(new Error(message), { code, status, data });

export function loggieCall<R, T>(operationName: string, context: Record<string, unknown>, request: string, { url, slug, timeoutSeconds }: LoggieTarget, { path = "", method = "POST", body, stop }: Call, accept: (reply: R, status: number) => T) {
  return withOperation(operationName, { ...context, request }, async (operation) => {
    const key = process.env.LOGGIE_API_KEY;
    if (!key) throw new Error("LOGGIE_API_KEY is not set");
    operation.stage("request");
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/proxy/${encodeURIComponent(slug)}/${path}`, {
      method, redirect: "error", signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
      headers: { ...body !== undefined && { "content-type": "application/json" }, "x-api-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reply = await response.json().catch(() => ({})) as R & Pick<Reply<never>, "error">;
    if (!response.ok || reply.error) {
      const code = reply.error?.code ?? "LOGGIE_HTTP";
      throw failure(`Loggie refused ${request} with HTTP ${response.status} ${code}${reply.error?.message ? `: ${reply.error.message}` : ""}`, code, response.status);
    }
    const accepted = accept(reply, response.status);
    operation.complete({ status: response.status });
    return accepted;
  });
}

export function loggie<T>(request: string, query: string, variables: Record<string, unknown> = {}, { stop, timeoutSeconds = config.storefront.loggie.timeoutSeconds }: { stop?: AbortSignal; timeoutSeconds?: number } = {}) {
  const { store, loggie: target } = config.storefront;
  return loggieCall<Reply<T>, T>("storefront.loggie", { store }, request, { ...target, timeoutSeconds }, { body: { query, variables }, stop }, (reply, status) => {
    if (reply.errors?.length) {
      throw failure(`Shopify rejected ${request}: ${reply.errors.map((error) => error.message).join("; ")}`, reply.errors[0]!.extensions?.code ?? "GRAPHQL_ERROR", status, reply.data);
    }
    if (!reply.data) throw failure(`Loggie returned no data for ${request}`, "GRAPHQL_ERROR", status);
    return reply.data;
  });
}
