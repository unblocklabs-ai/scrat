import { isIP } from "node:net";

export type Binding = { secret: string; hosts: string[]; header: string; prefix?: string };

const forbiddenHeaders = new Set(["host", "cookie", "set-cookie", "content-length", "connection", "transfer-encoding", "upgrade", "te", "expect", "proxy-authorization", "proxy-connection"]);

const placeholder = /^\$\{(\w+)\}$/;
const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const reservedHosts = new Set(["metadata.google.internal", "metadata.goog", "instance-data"]);
const reservedSuffixes = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

export function hostProblem(host: string) {
  if (isIP(host) || host.includes(":") || host.startsWith("[")) return `${host} is an IP address`;
  if (host === "localhost" || reservedHosts.has(host) || reservedSuffixes.some((suffix) => host.endsWith(suffix))) return `${host} is a local or metadata host`;
  if (!hostname.test(host) || /^[0-9x.]+$/.test(host) || !/[a-z]/.test(host.slice(host.lastIndexOf(".") + 1))) return `${host} is not an exact public hostname`;
  return undefined;
}

export function bindingSecret(binding: Pick<Binding, "secret">, source: NodeJS.ProcessEnv = process.env) {
  const name = placeholder.exec(binding.secret)?.[1], value = name ? source[name] : undefined;
  if (!value) throw new Error(`Binding secret ${binding.secret} is not set in the environment`);
  return value;
}

export function validateBindings(bindings: Record<string, unknown> | undefined, source: NodeJS.ProcessEnv = process.env) {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(bindings ?? {})) {
    const label = `bindings.${name}`, fail = (message: string) => problems.push(`${label}: ${message}`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail("name must be lowercase letters, digits and underscores");
    if (typeof value !== "object" || value === null || Array.isArray(value)) { fail("must be an object"); continue; }
    const { secret, hosts, header, prefix, ...rest } = value as Record<string, unknown>;
    for (const key of Object.keys(rest)) fail(`unknown key ${key}`);
    if (typeof secret !== "string" || !placeholder.test(secret)) fail('secret must be a "${VAR}" placeholder');
    else if (!source[placeholder.exec(secret)![1]]) fail(`${secret} is not set in the environment`);
    if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string")) fail("hosts must be a non-empty list of hostnames");
    else for (const host of hosts) { const problem = hostProblem(host); if (problem) fail(`hosts: ${problem}`); }
    if (typeof header !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(header) || forbiddenHeaders.has(header.toLowerCase())) fail("header must be a permitted header name");
    if (prefix !== undefined && (typeof prefix !== "string" || /[\r\n]/.test(prefix))) fail("prefix must be a single-line string");
  }
  return problems;
}
