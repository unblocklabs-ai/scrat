import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { config, getRepositoryPath, isActionEnabled } from "./config.ts";
import { ifMissing } from "./errors.ts";
import { git } from "./git.ts";
import { upsertSubject } from "./items.ts";
import { clip, loggie } from "./loggie.ts";
import { bestEffort, type OperationScope } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { enqueueOnce, pollSource } from "./sources.ts";
import { readState, statePath, writeState, writeStateText } from "./storefront.ts";

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Metafield = { namespace: string; key: string; value: string };
type Node = { id: string; handle: string; [field: string]: any };
type Resource = { kind: string; handle: string; visible: boolean; fields: Record<string, string> };
type Stored = { kind: string; handle: string; visible?: boolean; fields: Record<string, { hash: string; value: string }> };
type Snapshot = { resources: Record<string, Stored>; metaobjects: boolean; watched: string[] };
type Change = { resource: string; gid: string; handle: string; field: string; before?: string; after?: string; paths: string[]; note?: string; events?: string[] };
type State = { polledAt?: string; since?: string; changedAt?: string; pending: Change[] };
type Listing = { kind: string; root: string; first: number; selection: string; visible?: (node: Node) => boolean; fields: (node: Node) => Record<string, unknown> };

const stateFile = "changes/state.json", snapshotFile = "changes/snapshot.json", batches = "changes/batches", minuteMs = 60_000, dayMs = 86_400_000;
const denied = new Set(["ACCESS_DENIED", "SCOPE_UPGRADE_REQUIRED"]);
const route: Record<string, string> = { product: "products", collection: "collections", page: "pages" };
const subjectTypes: Record<string, string> = { product: "PRODUCT", collection: "COLLECTION", page: "PAGE" };
const pageInfo = "pageInfo { hasNextPage endCursor }";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const urlOf = ({ kind, handle }: Pick<Resource, "kind" | "handle">) => route[kind] ? `/${route[kind]}/${handle}` : undefined;
const metafields = (first: number) => `metafields(first: ${first}, keys: $keys) { nodes { namespace key value } }`;
const mine = (watched: Set<string>, nodes: Metafield[]) => Object.fromEntries(nodes.filter(({ namespace, key }) => watched.has(`${namespace}.${key}`)).map(({ namespace, key, value }) => [`metafield:${namespace}.${key}`, value]));
const keyOf = (field: string) => field.startsWith("metafield:") ? field.slice("metafield:".length) : undefined;

export const batchText = (key: string) => readFile(statePath(batches, `${key}.json`), "utf8");

async function watchedKeys() {
  const { extraMetafields, ignoreMetafields } = config.storefront.changes;
  const listed = await git(getRepositoryPath(), ["grep", "-ohE", String.raw`metafields\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, `refs/remotes/origin/${config.github.baseBranch}`, "--", "*.liquid", "*.json"])
    .catch((error: { code?: number }) => { if (error.code === 1) return ""; throw error; });
  const keys = new Set([...listed.split("\n").filter(Boolean).map((line) => line.slice("metafields.".length)), ...extraMetafields]);
  for (const key of ignoreMetafields) keys.delete(key);
  return keys;
}

async function all<D, N>(request: string, query: string, pick: (data: D) => Connection<N>, variables: Record<string, unknown> = {}) {
  const nodes: N[] = [];
  for (let after: string | null = null, more = true; more;) {
    const page = pick(await loggie<D>(`store_changes.${request}`, query, { ...variables, after }));
    nodes.push(...page.nodes);
    more = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }
  return nodes;
}

function listings(watched: Set<string>): Listing[] {
  const { pageSizes: size } = config.storefront.changes;
  return [
    { kind: "product", root: "products", first: size.products, selection: `handle title status descriptionHtml templateSuffix onlineStoreUrl ${metafields(size.metafields)}`, visible: (node) => node.status === "ACTIVE" && node.onlineStoreUrl !== null,
      fields: (node) => ({ handle: node.handle, title: node.title, status: node.status, descriptionHtml: node.descriptionHtml, templateSuffix: node.templateSuffix, published: node.onlineStoreUrl !== null, ...mine(watched, node.metafields.nodes) }) },
    { kind: "collection", root: "collections", first: size.collections, selection: `handle title descriptionHtml templateSuffix image { url } ${metafields(size.metafields)}`,
      fields: (node) => ({ handle: node.handle, title: node.title, descriptionHtml: node.descriptionHtml, image: node.image?.url, templateSuffix: node.templateSuffix, ...mine(watched, node.metafields.nodes) }) },
    { kind: "page", root: "pages", first: size.pages, selection: "handle title body templateSuffix isPublished", visible: (node) => node.isPublished,
      fields: (node) => ({ handle: node.handle, title: node.title, body: node.body, templateSuffix: node.templateSuffix, published: node.isPublished }) },
    { kind: "menu", root: "menus", first: size.menus, selection: "handle title items { title url items { title url items { title url } } }",
      fields: (node) => ({ handle: node.handle, title: node.title, items: JSON.stringify(node.items) }) },
  ];
}

async function metaobjects(log: OperationScope["log"]) {
  const { pageSizes: size, ignoreMetaobjectTypes } = config.storefront.changes, ignored = ignoreMetaobjectTypes ? new RegExp(ignoreMetaobjectTypes) : undefined;
  try {
    const definitions = await all<{ metaobjectDefinitions: Connection<{ type: string }> }, { type: string }>("metaobject_definitions",
      `query ($after: String) { metaobjectDefinitions(first: ${size.metaobjectDefinitions}, after: $after) { nodes { type } ${pageInfo} } }`, (data) => data.metaobjectDefinitions);
    const query = `query ($type: String!, $after: String) { metaobjects(type: $type, first: ${size.metaobjects}, after: $after) { nodes { id handle type fields { key value } } ${pageInfo} } }`;
    const found: { id: string; handle: string; type: string; fields: { key: string; value: string | null }[] }[] = [];
    for (const { type } of definitions) if (!ignored?.test(type)) found.push(...await all<{ metaobjects: Connection<(typeof found)[number]> }, (typeof found)[number]>("metaobjects", query, (data) => data.metaobjects, { type }));
    return found;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!code || !denied.has(code)) throw error;
    log.warn({ event: "store_changes.metaobjects_unavailable", code });
    return undefined;
  }
}

async function read(watched: Set<string>, log: OperationScope["log"]) {
  const current = new Map<string, Resource>(), kinds = new Set<string>(), { pageSizes: size } = config.storefront.changes;
  const put = (gid: string, kind: string, handle: string, fields: Record<string, unknown>, visible = true) => current.set(gid, { kind, handle, visible, fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, value === null || value === undefined ? "" : String(value)])) });
  for (const { kind, root, first, selection, fields, visible } of listings(watched)) {
    const query = `query ($after: String${selection.includes("$keys") ? ", $keys: [String!]" : ""}) { ${root}(first: ${first}, after: $after) { nodes { id ${selection} } ${pageInfo} } }`;
    for (const node of await all<Record<string, Connection<Node>>, Node>(root, query, (data) => data[root]!, { keys: [...watched] })) put(node.id, kind, node.handle, fields(node), visible?.(node) ?? true);
    kinds.add(kind);
  }
  const shop = await all<{ shop: { metafields: Connection<Metafield> } }, Metafield>("shop", `query ($after: String, $keys: [String!]) { shop { metafields(first: ${size.shopMetafields}, after: $after, keys: $keys) { nodes { namespace key value } ${pageInfo} } } }`, (data) => data.shop.metafields, { keys: [...watched] });
  put("shop", "shop", "shop", mine(watched, shop));
  kinds.add("shop");
  const objects = config.storefront.changes.metaobjects ? await metaobjects(log) : undefined;
  if (objects) {
    for (const { id, handle, type, fields } of objects) put(id, "metaobject", `${type}/${handle}`, Object.fromEntries(fields.map(({ key, value }) => [`field:${key}`, value])));
    kinds.add("metaobject");
  }
  return { current, kinds };
}

function pathsOf(gid: string, resource: Pick<Resource, "kind" | "handle">, current: Map<string, Resource>) {
  const own = urlOf(resource);
  if (own) return [own];
  const users = resource.kind === "metaobject"
    ? [...current.values()].filter((other) => Object.entries(other.fields).some(([field, value]) => keyOf(field) && value.includes(gid))).flatMap((other) => urlOf(other) ?? []) : [];
  return users.length ? users : ["/", ...config.storefront.auditPaths];
}

function compare(previous: Snapshot, current: Map<string, Resource>, kinds: Set<string>, watched: Set<string>) {
  const { valueBytes } = config.storefront.changes, changes: Change[] = [], resources: Record<string, Stored> = {}, before = new Set(previous.watched);
  const record = (gid: string, resource: Pick<Resource, "kind" | "handle">, field: string, was?: string, now?: string) => {
    const gone = field === "deleted" || (field === "status" && now !== "ACTIVE") || (field === "published" && now === "false");
    changes.push({ resource: resource.kind, gid, handle: resource.handle, field, before: was, after: now, paths: pathsOf(gid, resource, current), ...gone && { note: "Not visible on the storefront any more: expect a 404 on this page." } });
  };
  const comparable = (field: string) => { const key = keyOf(field); return key === undefined || (before.has(key) && watched.has(key)); };
  for (const [gid, resource] of current) {
    const stored = previous.resources[gid];
    resources[gid] = { kind: resource.kind, handle: resource.handle, visible: resource.visible, fields: Object.fromEntries(Object.entries(resource.fields).map(([field, value]) => [field, { hash: sha(value), value: clip(value, valueBytes) }])) };
    if (resource.kind === "metaobject" && !previous.metaobjects) continue;
    if (!stored) { if (resource.visible) record(gid, resource, "created", undefined, resource.handle); continue; }
    if (!resource.visible && stored.visible === false) continue;
    for (const field of new Set([...Object.keys(stored.fields), ...Object.keys(resource.fields)])) {
      const was = stored.fields[field], now = resource.fields[field];
      if (comparable(field) && was?.hash !== (now === undefined ? undefined : sha(now))) record(gid, resource, field, was?.value, now === undefined ? undefined : clip(now, valueBytes));
    }
  }
  for (const [gid, stored] of Object.entries(previous.resources)) {
    if (!kinds.has(stored.kind)) resources[gid] = stored;
    else if (!current.has(gid) && stored.visible !== false) record(gid, stored, "deleted", stored.handle);
  }
  return { changes, snapshot: { resources, metaobjects: previous.metaobjects || kinds.has("metaobject"), watched: [...watched] } satisfies Snapshot };
}

async function attribute(changes: Change[], since: string) {
  const query = `query ($query: String) { events(first: ${config.storefront.changes.pageSizes.events}, sortKey: CREATED_AT, reverse: true, query: $query) { nodes { message ... on BasicEvent { subjectId } } } }`;
  for (const kind of new Set(changes.map(({ resource }) => resource).filter((resource) => subjectTypes[resource]))) {
    const { events } = await loggie<{ events: { nodes: { message: string; subjectId?: string }[] } }>("store_changes.events", query, { query: `subject_type:${subjectTypes[kind]} AND created_at:>${since}` });
    for (const change of changes.filter(({ resource }) => resource === kind)) {
      const messages = new Set(events.nodes.filter(({ subjectId }) => subjectId === change.gid).map(({ message }) => message.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()));
      if (messages.size) change.events = [...messages];
    }
  }
}

function summarize(changes: Change[]) {
  const groups = new Map<string, Change[]>(), shown = [...new Set(changes.flatMap(({ events }) => events ?? []))].slice(0, config.storefront.changes.summaryEvents);
  for (const change of changes) groups.set(`${change.resource}:${change.field}`, [...groups.get(`${change.resource}:${change.field}`) ?? [], change]);
  const parts = [...groups.values()].map((list) => {
    const { resource, field, handle } = list[0]!, count = new Set(list.map(({ gid }) => gid)).size, many = count > 1, name = `\`${field.replace(/^(metafield|field):/, "")}\``;
    const subject = resource === "shop" ? "the shop" : many ? `${count} ${resource}s` : `${resource} \`${handle}\``;
    return `${subject} ${field === "created" ? many ? "were created" : "was created" : field === "deleted" ? many ? "were deleted" : "was deleted" : `had ${name} edited`}`;
  });
  return `Store data update in Shopify admin: ${parts.join("; ")}${shown.length ? ` (${shown.join("; ")})` : ""}.`;
}

function collapse(pending: Change[], incoming: Change[]) {
  const merged = [...pending];
  for (const change of incoming) {
    const at = merged.findIndex(({ gid, field }) => gid === change.gid && field === change.field);
    if (at < 0) { merged.push(change); continue; }
    const events = [...new Set([...merged[at]!.events ?? [], ...change.events ?? []])];
    merged[at] = { ...change, before: merged[at]!.before, ...events.length && { events } };
  }
  return merged.filter(({ before, after }) => before !== after);
}

async function prune(now: Date) {
  const root = statePath(batches);
  for (const name of await ifMissing(readdir(root), [])) {
    const stats = await ifMissing(stat(resolve(root, name)), undefined);
    if (stats && now.getTime() - stats.mtimeMs > config.storefront.changes.batchRetentionDays * dayMs) await rm(resolve(root, name), { force: true });
  }
}

async function detect(state: State, now: Date, log: OperationScope["log"]) {
  const previous = await readState<Snapshot | undefined>(snapshotFile, undefined), watched = await watchedKeys();
  const { current, kinds } = await read(watched, log);
  const { changes, snapshot } = compare(previous ?? { resources: {}, metaobjects: false, watched: [...watched] }, current, kinds, watched);
  const polledAt = state.polledAt;
  state.polledAt = now.toISOString();
  if (previous && changes.length) {
    if (polledAt) await bestEffort(log, "store_changes.events_failed", {}, () => attribute(changes, polledAt));
    state.pending = collapse(state.pending, changes);
    state.changedAt = state.polledAt;
    state.since ??= state.polledAt;
  }
  return !previous || JSON.stringify(snapshot) !== JSON.stringify(previous) ? snapshot : undefined;
}

async function flush(repository: string, action: string, state: State, end: string) {
  const start = state.since!;
  const { maxPages } = config.storefront.changes, summary = summarize(state.pending);
  const paths = [...new Set(state.pending.flatMap(({ paths }) => paths))], pages = paths.slice(0, maxPages).map((path) => `https://${config.storefront.publicHost}${path}`);
  await writeStateText(`${batches}/${start}.json`, JSON.stringify({ summary, pages, pagesNotListed: paths.length - pages.length, changes: state.pending }, null, 2) + "\n");
  const subject = upsertSubject({ repository, kind: "window", key: `${action}:${start}`, metadata: { start, end, summary } });
  return enqueueOnce(subject, action, summary, { source: "shopify", kind: "store_change", triggerKey: start });
}

async function pollAction({ name: action }: Action, operation: OperationScope, repository: string, now: Date) {
  if (!isActionEnabled(action)) {
    await rm(statePath(stateFile), { force: true });
    await rm(statePath(snapshotFile), { force: true });
    return 0;
  }
  const { pollMinutes, quietMinutes } = config.storefront.changes;
  const state = await readState<State>(stateFile, { pending: [] }) ?? { pending: [] };
  const snapshot = !state.polledAt || now.getTime() - Date.parse(state.polledAt) >= pollMinutes * minuteMs ? await detect(state, now, operation.log) : undefined;
  await prune(now);
  let queued = 0;
  if (state.pending.length && now.getTime() - Date.parse(state.changedAt!) >= quietMinutes * minuteMs) {
    operation.stage("enqueue");
    queued = await flush(repository, action, state, now.toISOString());
    state.pending = [];
    delete state.since;
    delete state.changedAt;
  }
  await writeState(stateFile, state);
  if (snapshot) await writeState(snapshotFile, snapshot);
  return queued;
}

export function pollStoreChanges(repository = config.github.repository, now = new Date()) {
  return pollSource("store_changes.poll", "shopify", repository, (manifest, operation) => pollAction(manifest, operation, repository, now));
}
