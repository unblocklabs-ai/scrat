import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Binding = { secret: string; hosts: string[]; header: string; prefix?: string };

type Answer = { address: string; family: number };
export type Resolver = (host: string) => Promise<Answer[]>;
export const resolveHost: Resolver = (host) => lookup(host, { all: true, verbatim: false });

const refused = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15]] as const) refused.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) refused.addSubnet(network, prefix, "ipv6");

const privateAddress = (address: string) => refused.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

export async function publicAnswers(host: string, resolve: Resolver) {
  const answers = await resolve(host).catch(() => []);
  const bad = answers.find((answer) => privateAddress(answer.address));
  if (bad) throw new Error(`Refused: ${host} resolves to private address ${bad.address}`);
  return answers.length ? answers : undefined;
}

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

export function bindingSecret(binding: Pick<Binding, "secret">) {
  const name = placeholder.exec(binding.secret)?.[1], value = name ? process.env[name] : undefined;
  if (!value) throw new Error(`Binding secret ${binding.secret} is not set in the environment`);
  return value;
}

export function validateBindings(bindings: Record<string, unknown> | undefined) {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(bindings ?? {})) {
    const label = `bindings.${name}`, fail = (message: string) => problems.push(`${label}: ${message}`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail("name must be lowercase letters, digits and underscores");
    if (typeof value !== "object" || value === null || Array.isArray(value)) { fail("must be an object"); continue; }
    const { secret, hosts, header, prefix, ...rest } = value as Record<string, unknown>;
    for (const key of Object.keys(rest)) fail(`unknown key ${key}`);
    if (typeof secret !== "string" || !placeholder.test(secret)) fail('secret must be a "${VAR}" placeholder');
    else if (!process.env[placeholder.exec(secret)![1]]) fail(`${secret} is not set in the environment`);
    if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string")) fail("hosts must be a non-empty list of hostnames");
    else for (const host of hosts) { const problem = hostProblem(host); if (problem) fail(`hosts: ${problem}`); }
    if (typeof header !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(header) || forbiddenHeaders.has(header.toLowerCase())) fail("header must be a permitted header name");
    if (prefix !== undefined && (typeof prefix !== "string" || /[\r\n]/.test(prefix))) fail("prefix must be a single-line string");
  }
  return problems;
}
