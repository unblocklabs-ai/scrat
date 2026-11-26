import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bearer, fixture } from "./fixture.mjs";

const scenario = process.argv[2] ?? "";
let f, db, s, tasks, git, commit;
const all = (table) => db.select().from(table).all();
const route = async () => (await f.app("github-sync.ts")).syncGitHub();
const run = async () => { const r = await f.runNextTask(); assert.ok(r); return r; };
const success = async () => { const r = await run(); assert.equal(r.error, null, JSON.stringify(r.error)); return r; };
const implement = async (n, title) => { f.addIssue(n, ["scrat"], title); f.enqueue(n, "implement"); return success(); };
const changeMain = (path, text) => {
  writeFileSync(resolve("seed", path), text); git(resolve("seed"), "add", "."); commit(resolve("seed"), "Change " + path);
  git(resolve("seed"), "push", resolve("remote.git"), "main");
};
const branchOff = (branch, path, text) => {
  git(resolve("seed"), "switch", "-c", branch); writeFileSync(resolve("seed", path), text);
  git(resolve("seed"), "add", "."); commit(resolve("seed"), "Branch " + branch);
  git(resolve("seed"), "push", resolve("remote.git"), branch); git(resolve("seed"), "switch", "main");
};
const pushFile = (branch, path, text) => {
  const remote = resolve("remote.git"), parent = git(remote, "rev-parse", branch), index = resolve("human-push.index"), env = { ...process.env, GIT_INDEX_FILE: index };
  rmSync(index, { force: true });
  execFileSync("git", ["-C", remote, "read-tree", parent], { env });
  if (text === null) execFileSync("git", ["-C", remote, "update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${path}\n` });
  else {
    const blob = execFileSync("git", ["-C", remote, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
    execFileSync("git", ["-C", remote, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
  }
  const tree = execFileSync("git", ["-C", remote, "write-tree"], { env, encoding: "utf8" }).trim();
  const next = git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", parent, "-m", "Human follow-up");
  git(remote, "update-ref", "refs/heads/" + branch, next);
  return next;
};
const touchPr = (number) => {
  const pr = f.prs.find((candidate) => candidate.number === number);
  pr.head.sha = pushFile(pr.head.ref, "touched.txt", `touched ${pr.head.sha}\n`);
};
const writeSync = fs.writeSync;
const captureLogs = () => {
  const lines = [];
  fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return writeSync(fd, data, ...rest); };
  return lines;
};
const restoreLogs = () => { fs.writeSync = writeSync; };
const humanComment = (number, id, body, at, anchor = "comment") => ({ id, body, user: { login: "human" }, updated_at: at, html_url: `https://github.com/fixture/project/pull/${number}#${anchor}` });
const script = (config, phase, source, name = phase) => {
  writeFileSync(name + ".mjs", source);
  config.workspace[phase] = [[process.execPath, resolve(name + ".mjs")]];
};
const botName = (name) => (config) => { config.github.botName = name; };
const configurePat = (config) => { config.github.auth = "pat"; config.github.botLogin = "agent-account"; };
const seedIgnore = () => writeFileSync("seed/.gitignore", "node_modules/\n");
const seedScopeSnapshots = () => {
  writeFileSync("seed/.gitignore", "/src/generated.ts\n");
  writeFileSync("seed/src/deleted.ts", "export const deleted = 1;\n");
  writeFileSync("seed/src/renamed.ts", "export const renamed = 1;\n");
  writeFileSync("seed/ leading.ts", "export const leading = 1;\n");
};
const seedIsolation = () => {
  writeFileSync("outside-secret.txt", "outside-secret-content\n");
  symlinkSync(resolve("outside-secret.txt"), "seed/src/link.txt");
  mkdirSync("outside-dir");
  symlinkSync(resolve("outside-dir"), "seed/linkdir");
};
const seedGitPaging = () => {
  writeFileSync("seed/src/mid.txt", Array.from({ length: 200_000 }, (_, n) => `line ${n}`).join("\n") + "\n");
  writeFileSync("seed/src/utf.txt", "é".repeat(3000));
  writeFileSync("seed/src/huge.txt", ("a".repeat(63) + "\n").repeat(17 * 16384 + 10));
};
const seedUnicodeScope = () => writeFileSync("seed/src/a b.ts", "export const special = 1;\n");
const seedUnicodeNfd = () => writeFileSync("seed/src/caf\u00e9.ts", "export const unicode = 1;\n");
const seedLockfile = () => {
  seedIgnore();
  mkdirSync("seed/assets/.vite", { recursive: true }); writeFileSync("seed/assets/.vite/manifest.json", "{}\n");
  writeFileSync("seed/package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "1.0.0" } }));
  writeFileSync("seed/pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@1.0.0:\n    resolution: {integrity: old}\n");
};
const configurePanel = (config) => {
  script(config, "prepare", 'import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("node_modules/pinned-runtime",{recursive:true});writeFileSync("node_modules/pinned-runtime/package.json",JSON.stringify({name:"pinned-runtime",version:"9.8.7"}));');
};
const configureScopeSnapshots = (config) => {
  script(config, "prepare", 'import{writeFileSync}from"node:fs";writeFileSync("src/generated.ts","export const generated = 1;\\n");');
};
const configureLockfile = (config) => {
  script(config, "prepare", 'import{mkdirSync,writeFileSync}from"node:fs";for(const name of ["wrangler","string-width-cjs"]){mkdirSync("node_modules/"+name,{recursive:true});writeFileSync("node_modules/"+name+"/package.json",JSON.stringify({name,version:"1.0.0"}));}');
};
const configureStaleBranch = (config) => {
  script(config, "prepare", 'import{existsSync}from"node:fs";for(const name of ["needed.txt","needed2.txt","needed3.txt","needed4.txt"]){if(existsSync(' + JSON.stringify(resolve(".") + "/require-") + '+name)&&!existsSync(name)){console.error("ERR_MISSING "+name);process.exit(1);}}');
  script(config, "validate", 'import{existsSync}from"node:fs";if(existsSync(' + JSON.stringify(resolve(".") + "/require-validation") + ')&&existsSync("bad.txt")){console.error("bad.txt must not exist");process.exit(7);}');
};
const configureIsolation = (config) => {
  writeFileSync("probe.mjs", 'import{appendFileSync}from"node:fs";const leaked=Object.entries(process.env).filter(([name,value])=>/PRIVATE_KEY|API_KEY|GITHUB_PAT/.test(name)||value.includes("PRIVATE KEY-----")||value.includes("ghp_")).map(([name])=>name);'
    + 'appendFileSync(' + JSON.stringify(resolve("isolation.jsonl")) + ',JSON.stringify({phase:process.argv[2],leaked,configured:process.env.SCRAT_WORKSPACE_VALUE})+"\\n");');
  config.workspace = { ...config.workspace, environment: { SCRAT_WORKSPACE_VALUE: "isolated" }, prepare: [[process.execPath, resolve("probe.mjs"), "prepare"]], validate: [[process.execPath, resolve("probe.mjs"), "validate"]] };
};
const configureCheck = (config) => {
  script(config, "validate", scenario === "validation_mutation" ? 'import{writeFileSync}from"node:fs";writeFileSync("src/app.ts","unexpected verification change\\n");' : 'import{existsSync}from"node:fs";if(existsSync("fail-validation")){console.log("validation detail ghs_fixture_sensitive");console.error("Verification failed");process.exit(7);}console.log("checked actual source");', "check");
};
const configureValidation = (config) => {
  const flag = (name) => JSON.stringify(resolve(name));
  script(config, "validate", 'import{appendFileSync,existsSync}from"node:fs";const s=Date.now();await new Promise((r)=>setTimeout(r,existsSync(' + flag("slow") + ')?300:0));'
    + 'appendFileSync(' + flag("validations.log") + ',JSON.stringify({s,e:Date.now()})+"\\n");if(existsSync(' + flag("kill-validation") + '))process.kill(process.pid,"SIGKILL");if(existsSync(' + flag("exit-137") + '))process.exit(137);'
    + 'if(existsSync(' + flag("slot-fail") + ')||existsSync("fail-validation")){console.log("validation detail ghs_fixture_sensitive");console.error("Verification failed: marker present");process.exit(7);}');
};
const configureChatty = (config) => {
  script(config, "validate", 'for(let i=0;i<20;i++)process.stdout.write("x".repeat(1024*1024)+"\\n");process.stdout.write("final line ghs_fixture_sensitive\\n");', "chatty");
  config.harness.commandOutputTailBytes = 2000;
};
const configureCommandTimeout = (config) => {
  script(config, "validate", 'await new Promise((r)=>setTimeout(r,30000));');
  config.harness.commandTimeoutSeconds = 1;
};
const configureResumePrepare = (config) => {
  script(config, "prepare", 'import{appendFileSync,mkdirSync,writeFileSync}from"node:fs";appendFileSync(' + JSON.stringify(resolve("prepare.log")) + ',"prepare\\n");mkdirSync("node_modules",{recursive:true});writeFileSync("node_modules/prepared","ready");');
};
const configureGuardsValidate = (config) => {
  writeFileSync("block-validation", "transient failure\n");
  script(config, "validate", 'import{existsSync}from"node:fs";if(existsSync(' + JSON.stringify(resolve("block-validation")) + ')){console.error("transient validation failure");process.exit(7);}console.log("validated saved source");');
};
const configureDatabase = (config) => {
  const helper = fileURLToPath(new URL("database-command.mjs", import.meta.url)); cpSync(helper, "database-command.mjs");
  config.workspace = { ...config.workspace, environment: { SCRAT_WORKSPACE_VALUE: "isolated" }, database: { image: "postgres:16-alpine", environment: ["DATABASE_URL", "TEST_DATABASE_URL"], migrate: [process.execPath, resolve("database-command.mjs"), "migrate"] }, validate: [[process.execPath, resolve("database-command.mjs"), scenario === "validation_resume" ? "validate-resume" : "validate", resolve("database-receipts.jsonl")]] };
};
const themeFiles = { "layout/theme.liquid": "<html>{{ content_for_layout }}</html>\n", "assets/app.css": "body { color: black; }\n", "templates/index.json": "{\"sections\":{}}\n", "config/settings_data.json": "{\"current\":{}}\n", "README.md": "# Theme\n" };
const heroPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const seedTheme = () => { for (const [path, text] of Object.entries(themeFiles)) { mkdirSync(resolve("seed", dirname(path)), { recursive: true }); writeFileSync(resolve("seed", path), text); } };
const seedStoreTheme = () => {
  mkdirSync("seed/snippets"); writeFileSync("seed/snippets/details.liquid", "{{ product.metafields.custom.watched.value }}{{ product.metafields.custom.skipped.value }}{{ shop.metafields.custom.watched.value }}\n");
};
const configureStorefront = (config) => {
  Object.assign(config.storefront, { enabled: true, store: "fixture.myshopify.com", publicHost: "shop.example.test" });
  Object.assign(config.storefront.preview, { processingPollSeconds: 1, uploadBatch: 2 });
};
const configureMainStorefront = (config) => {
  Object.assign(config.storefront, { enabled: true, store: "fixture.myshopify.com", publicHost: "shop.example.test" });
  config.storefront.lighthouse.runs = 2;
};
const storefrontScores = (performance, accessibility, practices, seo, [fcp, lcp, tbt, cls, speed] = [1800, 3100, 210, 0.05, 2900]) => Object.defineProperty({ performance, accessibility, "best-practices": practices, seo }, "metrics", {
  value: { "first-contentful-paint": fcp, "largest-contentful-paint": lcp, "total-blocking-time": tbt, "cumulative-layout-shift": cls, "speed-index": speed },
});
const mainStorefront = async () => {
  const scriptPath = resolve("lighthouse-script.json"), auditsPath = scriptPath + ".audits.jsonl";
  process.env.SCRAT_TEST_LIGHTHOUSE = scriptPath;
  writeFileSync(scriptPath, JSON.stringify({ mobile: [], desktop: [] })); writeFileSync(auditsPath, "");
  const script = (device) => ({ push: (...entries) => {
    const pending = JSON.parse(readFileSync(scriptPath, "utf8"));
    pending[device].push(...entries.map((entry) => typeof entry === "string" ? entry : { scores: { ...entry }, metrics: entry.metrics }));
    writeFileSync(scriptPath, JSON.stringify(pending));
  } });
  const fakes = globalThis.storefrontFakes = { launches: [], launchOptions: [], visits: [], get audits() { return readFileSync(auditsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }, scores: { mobile: script("mobile"), desktop: script("desktop") }, look: "v1" };
  const pkg = (name, source) => {
    const directory = resolve("app/src/node_modules", name); mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(resolve(directory, "index.js"), source);
  };
  pkg("playwright-core", `import { writeFileSync } from "node:fs";
const fakes = globalThis.storefrontFakes;
export const chromium = {
  executablePath: () => process.execPath,
  async launch({ args, ...options }) {
    fakes.launches.push(args); fakes.launchOptions.push(options);
    let current = "about:blank", width = 0;
    const page = {
      goto: async (url) => { current = url; fakes.visits.push(url); return { status: () => 200 }; },
      title: async () => "Fixture shop", url: () => current, innerText: async () => "Shop", innerHTML: async () => "<html></html>",
      screenshot: async ({ path }) => writeFileSync(path, "png " + new URL(current).pathname + " " + width + " " + fakes.look),
      waitForLoadState: async (_state, { timeout }) => { state.navigations.push(timeout); }, on: () => {}, off: () => {}, setViewportSize: async (size) => { width = size.width; },
      locator: () => ({ count: async () => 1 }), click: async () => {}, fill: async () => {}, selectOption: async () => {},
    };
    return { newContext: async ({ viewport }) => { width = viewport.width; return { route: async () => {}, newPage: async () => page, close: async () => {} }; }, close: async () => {} };
  },
};
`);
  pkg("lighthouse", `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
export const desktopConfig = { extends: "lighthouse:default", settings: { formFactor: "desktop" } };
export default async function lighthouse(url, flags, settings) {
  const path = process.env.SCRAT_TEST_LIGHTHOUSE, pending = JSON.parse(readFileSync(path, "utf8"));
  const device = settings === desktopConfig ? "desktop" : "mobile", next = pending[device].shift();
  writeFileSync(path, JSON.stringify(pending));
  appendFileSync(path + ".audits.jsonl", JSON.stringify({ url, device, port: flags.port, output: flags.output, categories: flags.onlyCategories, screenshot: !flags.disableFullPageScreenshot }) + "\\n");
  if (next === "hang") { setInterval(() => {}, 1000); return new Promise(() => {}); }
  if (typeof next === "string") throw new Error(next);
  return { lhr: { categories: Object.fromEntries(Object.entries(next.scores).map(([id, score]) => [id, { score }])), audits: Object.fromEntries(Object.entries(next.metrics).map(([id, numericValue]) => [id, { numericValue }])) }, report: JSON.stringify({ url, device, next: next.scores }) };
}
`);
  const dns = createRequire(import.meta.url)("node:dns/promises"), lookup = dns.lookup;
  dns.lookup = async (host, options) => host === "shop.example.test" ? [{ address: "93.184.216.34", family: 4 }] : lookup(host, options);
  syncBuiltinESMExports();
  process.env.LOGGIE_API_KEY = f.loggie.key;
  const { pollCommits } = await f.app("commit-source.ts");
  const seed = resolve("seed"), remote = resolve("remote.git");
  const theme = Object.fromEntries(Object.entries(themeFiles).filter(([path]) => path !== "README.md"));
  const push = async (files, synced = true) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(resolve(seed, path));
      else { mkdirSync(resolve(seed, dirname(path)), { recursive: true }); writeFileSync(resolve(seed, path), text); }
      if (synced && path !== "README.md") { if (text === null) delete theme[path]; else theme[path] = text; }
    }
    git(seed, "add", "-A"); commit(seed, "Change " + Object.keys(files).join(", ")); git(seed, "push", remote, "main");
    if (synced) f.loggie.setLive(theme);
    f.reset(0, "normal"); f.loggie.requests.length = 0;
    assert.equal(await pollCommits(), 1);
    return git(remote, "rev-parse", "main");
  };
  const scored = (mobile = [storefrontScores(0.6, 0.9, 0.96, 1), storefrontScores(0.6, 0.9, 0.96, 1)], desktop = [storefrontScores(0.9, 0.95, 1, 1), storefrontScores(0.9, 0.95, 1, 1)]) => {
    fakes.scores.mobile.push(...mobile); fakes.scores.desktop.push(...desktop);
  };
  f.loggie.setLive(theme);
  assert.equal(await pollCommits(), 0);
  return {
    fakes, theme, push, scored, previous: git(remote, "rev-parse", "main"),
    code: "The change looks safe on `main`.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete", codeText: "The change looks safe on `main`.",
    replies: () => f.slack.calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts).map((call) => call.body.text),
    replyBlocks: () => f.slack.calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts).map((call) => call.body.blocks),
    reactions: () => f.slack.calls.filter((call) => call.method === "reactions.add").map((call) => call.body.name),
    sessions: () => f.requests.filter((request) => request.context.storefront),
    reports: () => f.written("commit_comment"),
    state: (path) => readFileSync(resolve("data/storefront", path), "utf8"),
    link: (run) => `\n<${run.publication.storefrontReportUrl}|Full storefront report>`,
  };
};
const withTools = (text, tools) => text.replace(/^  tools: .*\n/m, "").replace(/^defaults:\n/m, `defaults:\n  tools: ${tools}\n`);
const configureManifestDirectory = (config) => {
  const directory = resolve("deployment");
  const copyWorkflow = (from, to, transformYaml) => {
    const dest = resolve(directory, to);
    cpSync(resolve("app/workflows", from), dest, { recursive: true });
    const yamlPath = resolve(dest, "workflow.yaml");
    const raw = readFileSync(yamlPath, "utf8").replace(new RegExp(`^name: ${from}$`, "m"), `name: ${to}`);
    writeFileSync(yamlPath, transformYaml ? transformYaml(raw) : raw);
  };
  mkdirSync(directory);
  config.workflows.directory = directory;
  config.workflows.trustLocalScripts = true;
  if (scenario === "manifest_directory") {
    copyWorkflow("review_issue", "review_triage");
    config.workflows.review_issue.enabled = false;
    config.workflows.review_triage = { provider: "fixture" };
    copyWorkflow("review_pr", "my_pr_review");
    config.workflows.my_pr_review = { provider: "fixture", reviewers: structuredClone(config.workflows.review_pr.reviewers) };
    config.workflows.review_pr.enabled = false;
  } else {
    copyWorkflow("review_issue", "review_issue", (text) => withTools(text, "[read, grep]") + "config:\n  files: []\n");
    copyWorkflow("implement", "implement", (text) => withTools(text, "[read, grep, find, ls, edit, write]").replace(/^config:\n/m, "config:\n  files: [discussion, history]\n"));
  }
};
const configureSchedule = (config) => {
  const directory = resolve("deployment");
  mkdirSync(directory);
  config.workflows.directory = directory;
  config.workflows.trustLocalScripts = true;
  const sweep = (name, cron, window, tools) => {
    const dir = resolve(directory, name);
    mkdirSync(dir, { recursive: true });
    cpSync("app/workflows/review_issue/SKILL.md", resolve(dir, "SKILL.md"));
    writeFileSync(resolve(dir, "workflow.yaml"), [
      `name: ${name}`, "enabled: true", "mode: review", "priority: 20",
      "on:", `  cron: "${cron}"`, `  window: ${window}`,
      "defaults:", "  provider: codex-lb", "  model: gpt-6.2-sol", "  thinkingLevel: high", `  tools: [${tools}]`,
      "permissions:", "  github: [read, issue]", "  workspace: [read]", "",
    ].join("\n"));
    writeFileSync(resolve(dir, "run.ts"), 'export default async function (ctx) { await ctx.review.run({ files: ["history"], publish: ["issue"] }); }\n');
  };
  sweep("error_sweep", "0 */6 * * *", "6h", "read, grep, find, ls");
  config.workflows.error_sweep = { provider: "fixture" };
  if (scenario === "schedule_source") { sweep("slow_sweep", "30 3 * * 1", "24h", "read, grep"); config.workflows.slow_sweep = { provider: "fixture" }; }
};
const configureCommitSource = (config) => {
  Object.assign(config.workflows.review_base_change, { enabled: true, config: { ...config.workflows.review_base_change.config, channel: "C0123456789" } });
};
const configureCommitPanel = (config) => {
  config.workflows.review_base_change.reviewers = structuredClone(config.workflows.review_pr.reviewers);
};
const configureNoStart = (config) => {
  config.workflows.review_base_change.config = { ...config.workflows.review_base_change.config, start: [] };
};
const configureHistory = (config) => {
  config.workflows.review_issue.config = { ...config.workflows.review_issue.config, files: ["discussion", "previous_assessment", "history"] };
};
const configureScoped = (config) => {
  config.bindings = { scout: { secret: "${SCOUT_TOKEN}", hosts: ["api.example.test", "other.example.test"], header: "Authorization", prefix: "Bearer " } };
  const scopedTools = { scoped_http: ["[read, grep, http]", "http: { binding: scout, methods: [GET] }"], bindings_startup: ["[read, grep, http]", "http: { binding: scout }"], scoped_github_search: ["[read, grep, github_search]", ""],
    scoped_browser: ["[read, grep, browser]", "browser: { navigationHosts: [shop.example.test], resourceHosts: [cdn.example.test], binding: scout }"] }[scenario];
  const directory = resolve("deployment");
  mkdirSync(directory);
  config.workflows.directory = directory;
  config.workflows.trustLocalScripts = true;
  const dest = resolve(directory, "review_issue");
  cpSync(resolve("app/workflows/review_issue"), dest, { recursive: true });
  writeFileSync(resolve(dest, "workflow.yaml"), withTools(readFileSync(resolve(dest, "workflow.yaml"), "utf8"), scopedTools[0]) + (scopedTools[1] ? scopedTools[1] + "\n" : ""));
};
const deletedReview = async (variant) => {
  await implement(1); await route(); f.faults.label.add(201);
  const older = await run(); assert.ok(older.error); assert.ok(older.publication.commentId);
  const itemId = f.row(s.tasks, older.taskId).subjectId;
  f.reset(201, "grade-A"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "New assessment", input: { source: "github_items", kind: "manual", manual: true } });
  if (variant === "unreceipted") f.faults.comment.add(201);
  const newer = await run();
  if (variant === "deleted") {
    assert.equal(newer.error, null);
    f.comments.set(201, []);
  } else {
    assert.ok(newer.error); assert.equal(newer.publication.commentId, undefined);
    assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
  }
  const calls = f.requests.length, updates = f.written("comment_update").length;
  tasks.retryTask(older.taskId); const superseded = await success();
  assert.equal(superseded.publication.status, "not_needed");
  assert.equal(f.requests.length, calls); assert.equal(f.botComments(201).length, 1);
  assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
  assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
  assert.equal(f.row(s.runs, newer.id).publication.commentId, f.comments.get(201)[0].id);
  if (variant === "deleted") {
    f.comments.set(201, []); await route();
    assert.equal(f.requests.length, calls); assert.equal(f.botComments(201).length, 1);
    assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
  } else {
    assert.equal(f.written("comment_update").length, updates);
    tasks.retryTask(newer.taskId); await success(); assert.equal(f.requests.length, calls);
  }
};
const staleBranch = async (variant) => {
  const remoteGit = (...args) => git(resolve("remote.git"), ...args);
  const needs = (name) => writeFileSync(`require-${name}`, "");
  const prItem = (n) => all(s.items).find((i) => i.kind === "pr" && i.payload.number === n);
  const queuedFor = (n) => all(s.tasks).filter((t) => t.subjectId === prItem(n).id && t.status === "queued").map((t) => t.action).sort();
  const drainExcept = (n) => { for (const item of all(s.items)) if (item.id !== prItem(n).id) tasks.cancelPendingTasks(item.id, "Isolate"); };
  const parents = (cwd, rev) => git(cwd, "show", "-s", "--format=%P", rev).split(" ");
  const checkout = f.config.github.repositoryPath;
  const mainHead = () => git(resolve("seed"), "rev-parse", "main");
  if (variant === "human") {
    branchOff("feature-a", "src/feature.ts", "export const feature = 1;\n");
    branchOff("feature-b", "src/app.ts", "export const value = 7;\n");
    needs("needed.txt");
    changeMain("needed.txt", "ok\n");
    f.addPr(301, "feature-a", "human"); await route();
    const heads = remoteGit("for-each-ref", "refs/heads"), realHead = remoteGit("rev-parse", "feature-a"), main1 = mainHead();
    const reviewed = await success();
    assert.equal(reviewed.headSha, realHead, "the run records the real PR head");
    const reviewRequests = f.requests.filter((r) => r.context.action === "review_pr");
    assert.ok(reviewRequests.length >= 3);
    for (const { context } of reviewRequests) {
      assert.notEqual(context.workspace.headSha, realHead);
      assert.deepEqual(parents(checkout, context.workspace.headSha), [realHead, main1]);
      assert.equal(context.diffBaseSha, main1); assert.deepEqual(context.diffPaths, ["src/feature.ts"]);
      assert.equal(context.headSha, realHead);
    }
    assert.equal(remoteGit("for-each-ref", "refs/heads"), heads, "nothing is pushed");
    assert.ok(!f.writes.some((w) => w.type === "pr"));
    assert.equal(f.comments.get(301).length, 1); assert.doesNotMatch(f.comments.get(301)[0].body, /behind|merge/i);
    assert.ok(all(s.workspaces).every((w) => w.removedAt), "review workspaces are cleaned up");
    f.prs[0].state = "closed"; await route();
    changeMain("src/app.ts", "export const value = 9;\n");
    f.addPr(302, "feature-b", "human"); await route();
    const calls = f.requests.length, heads2 = remoteGit("for-each-ref", "refs/heads");
    const conflicted = await run();
    assert.equal(conflicted.error.message, "PR branch is behind main and does not merge cleanly; the author needs to update it");
    assert.equal(f.requests.length, calls); assert.equal(remoteGit("for-each-ref", "refs/heads"), heads2);
    assert.equal(f.comments.get(302)?.length ?? 0, 0);
    assert.ok(all(s.workspaces).every((w) => w.removedAt));
    const notices = () => (f.comments.get(302) ?? []).filter((c) => /does not merge cleanly/.test(c.body));
    await route(); await route();
    assert.equal(notices().length, 1); assert.match(notices()[0].body, /behind main/); assert.deepEqual(queuedFor(302), []);
    assert.deepEqual(f.prs[1].labels, []);
    const writes = f.writes.length;
    changeMain("src/other.ts", "export const other = 1;\n"); await route();
    assert.deepEqual(queuedFor(302), ["review_pr"], "a base move re-queues one review"); assert.equal(f.writes.length, writes, "a base move writes nothing");
    assert.ok((await run()).error); await route();
    assert.equal(notices().length, 1); assert.deepEqual(queuedFor(302), [], "a conflict on the new base blocks again");
    tasks.enqueueManualTasks("review_pr", ["302"]); await route();
    assert.deepEqual(queuedFor(302), ["review_pr"], "a manual request survives routing");
    assert.ok((await run()).error); await route();
    assert.equal(notices().length, 1); assert.equal(f.comments.get(302).length, 1); assert.deepEqual(queuedFor(302), []);
    branchOff("release", "release.txt", "release\n"); f.prs[1].base.ref = "release"; await route();
    assert.deepEqual(queuedFor(302), ["review_pr"], "a retargeted PR is no longer blocked");
    f.prs[1].base.ref = "main"; await route(); assert.deepEqual(queuedFor(302), []);
    pushFile("feature-b", "src/app.ts", "export const value = 9;\n"); f.prs[1].head.sha = remoteGit("rev-parse", "feature-b"); await route();
    assert.deepEqual(queuedFor(302), ["review_pr"]);
    await success(); await route();
    assert.equal(f.comments.get(302).length, 1); assert.equal(notices().length, 0); assert.equal(f.prs[1].labels.length, 1);
    f.prs[1].state = "closed"; await route();
    branchOff("feature-c", "src/c.ts", "export const c = 1;\n"); needs("needed4.txt");
    f.addPr(303, "feature-c", "human"); await route();
    const workspaces = all(s.workspaces).length, requests = f.requests.length, unmasked = await run();
    assert.match(unmasked.error.stdout, /ERR_MISSING needed4\.txt/); assert.equal(f.requests.length, requests);
    assert.equal(all(s.workspaces).length, workspaces + 1, "no synthetic workspace is made");
  } else {
    await implement(1); await route(); drainExcept(201);
    const pr = f.prs[0];
    needs("needed.txt"); changeMain("needed.txt", "ok\n");
    tasks.cancelPendingTasks(prItem(201).id, "Fresh start"); await route();
    assert.deepEqual(queuedFor(201), ["review_pr"], "a clean, behind branch is not updated before anything fails");
    const calls = f.requests.length, staleHead = remoteGit("rev-parse", pr.head.ref);
    const failed = await run();
    assert.match(failed.error.stdout, /ERR_MISSING needed\.txt/); assert.equal(failed.stage, "preparing"); assert.equal(failed.headSha, staleHead);
    await route(); assert.deepEqual(queuedFor(201), ["resolve_conflicts"]);
    await route(); assert.deepEqual(queuedFor(201), ["resolve_conflicts"], "routing neither duplicates nor cancels the update");
    const update = await success();
    assert.equal(f.requests.length, calls, "a clean update needs no model");
    const merged = remoteGit("rev-parse", pr.head.ref);
    assert.notEqual(merged, staleHead); assert.equal(parents(resolve("remote.git"), merged).length, 2);
    remoteGit("merge-base", "--is-ancestor", mainHead(), merged);
    assert.equal(update.publication.publishedCommitSha, merged); assert.match(f.comments.get(201).at(-1).body, /Merged main \(\w{7}\) into this branch; no conflicts/);
    await route(); assert.deepEqual(queuedFor(201), ["review_pr"], "the new head gets a fresh review and no further update");
    await success(); await route(); assert.deepEqual(queuedFor(201), []);
    assert.equal(all(s.tasks).filter((t) => t.action === "resolve_conflicts").length, 1);

    changeMain("ci-base.txt", "ok\n");
    pr.mergeable_state = "blocked";
    const testMerge = pr.merge_commit_sha = "a".repeat(40);
    const requiredFailure = { __typename: "CheckRun", isRequired: true, status: "COMPLETED", conclusion: "FAILURE" };
    const nonBlocking = [{ ...requiredFailure, isRequired: false }, { ...requiredFailure, status: "IN_PROGRESS", conclusion: null }];
    f.checkRollups.set(merged, [requiredFailure]);
    f.checkRollups.set(testMerge, nonBlocking);
    await route(); assert.ok(!queuedFor(201).includes("resolve_conflicts"), "the test merge's pending and optional checks take precedence over a failing head check");
    f.checkRollups.delete(testMerge);
    await route(); assert.ok(queuedFor(201).includes("resolve_conflicts"), "when the test merge has no checks, a failed required head check queues a refresh");
    f.checkRollups.set(testMerge, nonBlocking);
    await route(); assert.ok(!queuedFor(201).includes("resolve_conflicts"), "a later poll cancels a refresh whose only trigger cleared");
    pr.base.sha = remoteGit("rev-parse", "main^");
    await route(); assert.ok(queuedFor(201).includes("resolve_conflicts"), "an obsolete test merge does not hide a failed check on the current head");
    delete pr.base.sha;
    f.checkRollups.set(testMerge, [...Array(100).fill(nonBlocking[0]), requiredFailure]);
    await route(); await route();
    assert.equal(queuedFor(201).filter((action) => action === "resolve_conflicts").length, 1, "a required test-merge failure queues one refresh across polls");
    const refreshed = await success();
    assert.deepEqual(parents(resolve("remote.git"), refreshed.publication.publishedCommitSha), [merged, mainHead()]);
    await route(); assert.ok(!queuedFor(201).includes("resolve_conflicts"), "a red check does not trigger a refresh when the branch is current");
    await success();

    changeMain("strict-base.txt", "ok\n");
    pr.mergeable_state = "behind";
    f.checkRollups.delete(testMerge);
    await route(); assert.ok(queuedFor(201).includes("resolve_conflicts"), "GitHub's up-to-date requirement queues a refresh even without failed CI");
    changeMain("new-base.txt", "ok\n");
    await success();
    assert.equal(remoteGit("rev-parse", pr.head.ref), refreshed.publication.publishedCommitSha, "a refresh queued for an older base does not push");
    await route();
    const strictRefresh = await success();
    assert.deepEqual(parents(resolve("remote.git"), strictRefresh.publication.publishedCommitSha), [refreshed.publication.publishedCommitSha, mainHead()]);

    await implement(2); drainExcept(202);
    changeMain("bad.txt", "bad\n"); writeFileSync("require-validation", "");
    const fallback = tasks.enqueueTask({ subjectId: prItem(202).id, action: "resolve_conflicts", reason: "Exercise fallback", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(202, "remove-bad");
    const repaired = await success(); assert.equal(repaired.taskId, fallback.id);
    const request = f.requests.findLast((r) => r.context.action === "resolve_conflicts" && r.context.item.number === 202);
    assert.match(readFileSync(request.context.files.validationFailure, "utf8"), /bad\.txt must not exist/);
    assert.equal(request.context.diffBaseSha, mainHead(), "the agent diffs against the main it was merged with");
    assert.equal(request.context.workspace.mergeInProgress, false);
    assert.equal(parents(f.row(s.workspaces, repaired.workspaceId).path, request.context.workspace.headSha).length, 2, "the agent starts from the merge commit");
    const head2 = remoteGit("rev-parse", f.prs[1].head.ref);
    remoteGit("merge-base", "--is-ancestor", mainHead(), head2);
    assert.throws(() => remoteGit("cat-file", "-e", head2 + ":bad.txt"));
    unlinkSync("require-validation");
    await implement(3); drainExcept(203);
    needs("needed2.txt"); changeMain("needed2.txt", "ok\n"); changeMain("src/app.ts", "export const value = 99;\n");
    tasks.enqueueTask({ subjectId: prItem(203).id, action: "resolve_conflicts", reason: "Exercise bug fix", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(203, "resolve"); const resolved = await success();
    assert.ok(f.requests.some((r) => r.context.action === "resolve_conflicts" && r.context.item.number === 203));
    const head3 = remoteGit("rev-parse", f.prs[2].head.ref);
    assert.equal(parents(resolve("remote.git"), head3).length, 2);
    assert.equal(remoteGit("show", head3 + ":src/app.ts"), "export const value = 300;"); assert.equal(resolved.publication.publishedCommitSha, head3);
    assert.match(remoteGit("log", "-1", "--format=%s", head3), /^Merge/, "A conflict-resolving merge keeps its merge message");
    await implement(4); drainExcept(204);
    needs("needed3.txt"); changeMain("needed3.txt", "ok\n");
    tasks.enqueueTask({ subjectId: prItem(204).id, action: "address_pr_feedback", reason: "Exercise self-heal", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(204, "normal"); const healed = await success();
    const healedRequest = f.requests.findLast((r) => r.context.action === "address_pr_feedback" && r.context.item.number === 204);
    assert.equal(healedRequest.context.diffBaseSha, mainHead(), "the agent diffs against the main it was merged with");
    const head4 = remoteGit("rev-parse", f.prs[3].head.ref);
    remoteGit("merge-base", "--is-ancestor", mainHead(), head4);
    assert.equal(healed.publication.publishedCommitSha, head4); assert.equal(remoteGit("show", head4 + ":src/app.ts"), "export const value = 214;");
    assert.equal(remoteGit("show", head4 + ":needed3.txt"), "ok");
    assert.equal(remoteGit("log", "-1", "--format=%s", head4), `Address feedback: ${f.prs[3].title}`, "A repair commit says what it repairs, not just the PR title");
    await implement(5, "fix(auth): x"); await implement(6, "Bug: y");
    assert.deepEqual([f.prs[4].title, f.prs[5].title], ["fix(auth): x", "fix: Bug: y"]);
    assert.deepEqual([4, 5].map((i) => remoteGit("log", "-1", "--format=%s", f.prs[i].head.ref)), ["fix(auth): x", "fix: Bug: y"]);
  }
};
const validationFeedback = async (variant) => {
  const validations = () => existsSync("validations.log") ? readFileSync("validations.log", "utf8").trim().split("\n").length : 0;
  const lastUser = ({ request }) => { const { content } = request.messages.at(-1); return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n"); };
  const feedbackRequests = () => f.requests.filter((entry) => entry.request.messages.at(-1).role === "user" && lastUser(entry).startsWith(`${f.config.github.botName}'s validation failed`));
  if (variant === "fix") {
    f.addIssue(1, ["scrat"]); f.reset(1, "feedback-fix"); f.enqueue(1, "implement"); const r = await success();
    assert.equal(r.verification.headSha, r.publication.publishedCommitSha); assert.equal(validations(), 2);
    assert.equal(readdirSync("data/pi-sessions", { recursive: true }).filter((name) => name.endsWith(".jsonl")).length, 1);
    const [message] = feedbackRequests(), text = lastUser(message);
    assert.equal(feedbackRequests().length, 1);
    assert.match(text, /round 1 of 2/); assert.match(text, /Exit code: 7/); assert.match(text, /Verification failed: marker present/); assert.ok(text.length < 20_000);
    assert.ok(!text.includes("ghs_fixture_sensitive")); assert.match(text, /validation detail/);
    assert.equal(git(resolve("remote.git"), "rev-list", "--count", `main..${f.prs[0].head.ref}`), "1");
    assert.ok(!existsSync(resolve(f.row(s.workspaces, r.workspaceId).path, "fail-validation")));
    assert.match(r.result.text, /^Implemented the change\./);
    assert.match(r.result.text, /\*\*Validation correction 1:\*\* Fixed the validation failure\./);
    assert.match(f.prs[0].body, /Implemented the change\.[\s\S]*Fixed the validation failure\./);
    const turns = () => f.requests.filter((entry) => entry.request.messages.at(-1).role === "user").length - feedbackRequests().length;
    f.addIssue(2, ["scrat"]); f.reset(2, "feedback-fix"); f.enqueue(2, "implement");
    f.comments.set(2, [humanComment(2, 9100, "Only the discussion file says this", "2026-10-19T01:00:00Z")]);
    const stop = new AbortController(); f.onModel = () => stop.abort();
    const cut = await f.runNextTask(stop.signal); f.onModel = undefined;
    assert.equal(cut.stage, "validating"); assert.equal(f.row(s.tasks, cut.taskId).retryMode, "validation");
    const started = turns(), asked = feedbackRequests().length, checked = validations();
    f.script = [undefined, undefined, { name: "read", args: { path: f.requests.at(-1).context.files.discussion } }, { name: "bash", args: { command: "rm -f fail-validation" } }];
    const resumed = await success(); f.script = undefined;
    assert.match(JSON.stringify(f.requests.at(-1).request.messages), /Only the discussion file says this/, "a resumed correction round can read the original context files");
    assert.equal(resumed.inferenceFromRunId, cut.id); assert.equal(resumed.piSessionId, cut.piSessionId);
    assert.equal(turns(), started, "the resumed run starts no new agent turn");
    assert.equal(feedbackRequests().length, asked + 1); assert.match(lastUser(feedbackRequests().at(-1)), /round 1 of 2/);
    assert.equal(validations(), checked + 2); assert.equal(f.prs.length, 2);
    assert.equal(git(resolve("remote.git"), "rev-list", "--count", `main..${f.prs[1].head.ref}`), "1");
    assert.match(resumed.result.text, /^Implemented the change\.[\s\S]*\*\*Validation correction 1:\*\* Fixed the validation failure\./);
  } else {
    f.addIssue(1, ["scrat"]); f.reset(1, "feedback-stubborn"); f.enqueue(1, "implement"); const failed = await run();
    assert.equal(failed.error.exitCode, 7); assert.equal(failed.verification, null); assert.equal(f.prs.length, 0);
    assert.equal(validations(), 3); assert.equal(feedbackRequests().length, 2);
    assert.match(lastUser(feedbackRequests()[1]), /round 2 of 2/);
    writeFileSync("kill-validation", ""); f.addIssue(2, ["scrat"]); f.enqueue(2, "implement");
    const before = validations(), killed = await run();
    assert.ok(killed.error); assert.equal(killed.error.name, "Error"); assert.equal(killed.error.exitCode, undefined); assert.equal(killed.stage, "validating");
    assert.equal(validations(), before + 1); assert.equal(feedbackRequests().length, 2);
    rmSync("kill-validation"); writeFileSync("exit-137", ""); f.addIssue(3, ["scrat"]); f.enqueue(3, "implement");
    const wrapped = await run();
    assert.equal(wrapped.error.exitCode, 137); assert.equal(feedbackRequests().length, 2);
    rmSync("exit-137"); const { config } = await f.app("config.ts"); config.harness.corrections.validation = 1;
    f.addIssue(4, ["scrat"]); f.reset(4, "feedback-stubborn"); f.enqueue(4, "implement");
    const limited = await run();
    assert.equal(limited.error.exitCode, 7); assert.equal(feedbackRequests().length, 3);
    assert.match(lastUser(feedbackRequests()[2]), /round 1 of 1/);
    const marked = (n) => f.issues.get(n).labels.some(({ name }) => name === "Scrat failed");
    await route(); assert.ok([1, 2, 3, 4].every(marked), "a change task that failed for good labels its issue");
    const labelWrites = () => f.written("label", (w) => w.method !== "GET").length;
    const written = labelWrites(); await route(); assert.equal(labelWrites(), written, "a steady state writes no label");
    f.addIssue(5, ["scrat"]); f.enqueue(5, "implement"); const stop = new AbortController(); f.onModel = () => stop.abort();
    const cut = await f.runNextTask(stop.signal); f.onModel = undefined; assert.equal(f.row(s.tasks, cut.taskId).status, "queued");
    await route(); assert.ok(!marked(5), "an interrupted task is not labelled");
    tasks.retryTask(limited.taskId); await route(); assert.ok(!marked(4), "a retried task clears the label"); assert.ok(marked(3));
    f.issues.get(3).labels = f.issues.get(3).labels.filter(({ name }) => name !== "scrat"); await route();
    assert.ok(!marked(3), "deselecting an issue clears the label"); assert.ok(marked(2));
    config.workflows.implement.enabled = false; f.addIssue(6, ["scrat"]); await route();
    assert.deepEqual(all(s.tasks).filter((t) => t.subjectId === "issue-6" && t.action === "implement"), [], "a disabled action gets no task to fail and label");
  }
};
const commitReview = async (variant) => {
  const { pollCommits } = await f.app("commit-source.ts");
  const seed = resolve("seed"), remote = resolve("remote.git"), channel = "C0123456789";
  const tip = () => git(remote, "rev-parse", "main");
  const posts = () => f.slack.calls.filter((call) => call.method === "chat.postMessage");
  const roots = () => posts().filter((call) => call.body.thread_ts === undefined);
  const push = async (message, value = 2) => {
    writeFileSync(resolve(seed, "src/app.ts"), `export const value = ${value};\n`); git(seed, "add", "."); commit(seed, message);
    git(seed, "push", remote, "main"); return pollCommits();
  };
  const reviewRequests = () => f.requests.filter((request) => request.context.action === "review_base_change");
  const reactions = () => f.slack.calls.filter((call) => call.method === "reactions.add");
  const bot = f.config.github.botName;
  assert.equal(await pollCommits(), 0); assert.equal(f.slack.calls.length, 0);
  const previous = tip();
  if (variant === "e2e") {
    f.verdicts.default = "clean";
    assert.equal(await push("Fix a<b & c>d"), 1);
    const head = tip(); assert.equal(f.slack.calls.length, 0);
    const r = await success();
    assert.equal(posts().length, 2); const [root, reply] = posts();
    assert.deepEqual(root.body, {
      channel, unfurl_links: false, unfurl_media: false, link_names: false,
      text: `Store update: Fixture changed the theme: <https://github.com/fixture/project/commit/${head}|"Fix a&lt;b &amp; c&gt;d">. ${bot} is checking the live site.`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Store update: Fixture changed the theme: <https://github.com/fixture/project/commit/${head}|"Fix a&lt;b &amp; c&gt;d">. ${bot} is checking the live site.` } }],
    });
    assert.equal(reply.body.thread_ts, "1700000000.000001"); assert.equal(reply.body.text, "Independent review from gpt-6.2-sol. &lt;!channel&gt;");
    assert.deepEqual(reply.body.blocks, [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Independent review from gpt-6.2-sol. <!channel>" }] }] }]);
    assert.ok(posts().every((call) => call.token === process.env.SLACK_BOT_TOKEN));
    const [thread] = all(s.slackThreads); assert.equal(all(s.slackThreads).length, 1);
    assert.deepEqual({ subjectId: thread.subjectId, channel: thread.channel, ts: thread.ts }, { subjectId: all(s.tasks)[0].subjectId, channel, ts: "1700000000.000001" });
    assert.equal(r.publication.slackReplyTs, "1700000000.000002"); assert.equal(r.publication.status, "published");
    assert.equal(r.stage, "publishing"); assert.equal(r.result.text, "Independent review from gpt-6.2-sol. <!channel>"); assert.deepEqual(r.result.paths.filter((path) => path === "src/app.ts"), ["src/app.ts"]);
    assert.equal(r.context.item.number, 0); assert.equal(r.mainSha, head); assert.equal(r.headSha, head);
    assert.equal(f.row(s.tasks, r.taskId).status, "completed"); assert.equal(all(s.subjects)[0].state, "open");
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
    const requests = reviewRequests(); assert.equal(requests.length, 4); assert.equal(new Set(requests.map((request) => request.request.model)).size, 1);
    const { context } = requests[0];
    assert.deepEqual(context.diffPaths, ["src/app.ts"]); assert.equal(context.diffBaseSha, previous);
    assert.equal(context.workspace.baseRef, head); assert.equal(context.workspace.headSha, head); assert.equal(context.workspace.mainSha, head);
    assert.deepEqual(context.item, { number: 0, title: "Fix a<b & c>d", body: "", url: `https://github.com/fixture/project/commit/${head}` });
    assert.equal(context.input.previousSha, previous); assert.equal(context.input.sha, head); assert.equal(context.input.commitCount, 1);
    assert.equal(context.commentRevisions.length, 0);
    assert.equal(f.writes.length, 0); assert.equal(all(s.runs).length, 1);
    const rootTs = "1700000000.000001", reacted = (calls) => calls.map((call) => [call.body.channel, call.body.timestamp, call.body.name]);
    assert.deepEqual(reacted(reactions()), [[channel, rootTs, "white_check_mark"]]);
    assert.equal(r.result.verdict, "clean"); assert.equal(r.publication.slackReaction, "white_check_mark"); assert.ok(!reply.body.text.includes("SCRAT_VERDICT"));
    assert.ok(reactions().every((call) => call.token === process.env.SLACK_BOT_TOKEN));
    const review = async (value, verdict) => {
      f.verdicts.default = verdict; assert.equal(await push("Verdict " + value, value), 1);
      const before = reactions().length, done = await success();
      const root = all(s.slackThreads).find((row) => row.subjectId === f.row(s.tasks, done.taskId).subjectId);
      return { done, root: root.ts, added: reacted(reactions().slice(before)) };
    };
    const concerns = await review(3, "concerns");
    assert.deepEqual(concerns.added, [[channel, concerns.root, "large_orange_square"]]);
    const missing = await review(4, undefined);
    assert.deepEqual(missing.added, []); assert.equal(missing.done.result.verdict, undefined); assert.equal(missing.done.publication.slackReaction, undefined);
    const { parseResult } = await f.app("results.ts");
    assert.throws(() => parseResult("Fine.\nSCRAT_VERDICT: safe\nSCRAT_STATUS: complete", []), /SCRAT_VERDICT/);
    assert.equal(parseResult("Fine.\nSCRAT_VERDICT: breaking\nSCRAT_STATUS: complete", []).verdict, "breaking");
    f.slack.reactionFail = ["already_reacted"];
    const repeated = await review(5, "breaking");
    assert.deepEqual(repeated.added, [[channel, repeated.root, "large_red_square"]]); assert.equal(repeated.done.publication.slackReaction, "large_red_square");
    f.addPr(7, "main", "human", { title: "Cart drawer <fix>", state: "closed", merged_by: { login: "Bek" } });
    assert.equal(await push("Merge pull request #7 from fixture/topic", 8), 1); await success();
    assert.equal(roots().at(-1).body.text, `Store update: <https://github.com/fixture/project/pull/7|*Cart drawer &lt;fix&gt;*> (PR #7, merged by Bek). ${bot} is checking the live site.`);
    mkdirSync(resolve(seed, "templates"), { recursive: true }); mkdirSync(resolve(seed, "config"), { recursive: true });
    writeFileSync(resolve(seed, "templates/index.json"), "{}\n"); writeFileSync(resolve(seed, "config/settings_data.json"), "{}\n"); git(seed, "add", ".");
    git(seed, "-c", "user.name=shopify[bot]", "-c", "user.email=bot@example.invalid", "commit", "-m", "Update from Shopify for theme fixture/main"); git(seed, "push", remote, "main");
    assert.equal(await pollCommits(), 1); const shopified = tip(); await success();
    assert.equal(roots().at(-1).body.text, `Store update: <https://github.com/fixture/project/commit/${shopified}|the theme settings and home page template were edited in the Shopify theme editor>. ${bot} is checking the live site.`);
    f.verdicts.default = "clean"; f.modes.set(0, "incomplete");
    assert.equal(await push("Incomplete", 6), 1);
    const reactionsBefore = reactions().length, incomplete = await run();
    assert.ok(incomplete.error); assert.equal(reactions().length, reactionsBefore);
    f.modes.delete(0); tasks.retryTask(incomplete.taskId); await success();
    f.verdicts.default = "concerns"; f.slack.reactionFail = ["service_unavailable"];
    assert.equal(await push("Reaction down", 7), 1);
    const replies = () => posts().filter((call) => call.body.thread_ts !== undefined).length, postsBefore = replies(), callsBefore = reactions().length, failed = await run();
    assert.ok(failed.error); assert.equal(failed.stage, "publishing");
    assert.equal(failed.publication.slackReplyTs !== undefined, true); assert.equal(failed.publication.slackReaction, undefined);
    assert.equal(replies() - postsBefore, 1); assert.equal(f.row(s.tasks, failed.taskId).status, "failed");
    const used = f.requests.length; tasks.retryTask(failed.taskId);
    const retried = await success();
    assert.equal(f.requests.length, used); assert.equal(replies() - postsBefore, 1);
    const failedRoot = all(s.slackThreads).find((row) => row.subjectId === f.row(s.tasks, failed.taskId).subjectId);
    assert.deepEqual(reacted(reactions().slice(callsBefore)), [[channel, failedRoot.ts, "large_orange_square"], [channel, failedRoot.ts, "large_orange_square"]]);
    assert.equal(retried.publication.slackReaction, "large_orange_square");
    assert.equal(retried.publication.slackReplyTs, failed.publication.slackReplyTs);
  } else if (variant === "no_start") {
    f.verdicts.default = "concerns";
    let before;
    f.onModel = (_context, step) => { if (step === 0 && before === undefined) before = posts().length; };
    assert.equal(await push("No start slot"), 1);
    await success();
    assert.equal(before, 0, "no root is posted before the agent runs");
    assert.equal(posts().length, 2); assert.equal(roots().length, 1); assert.equal(all(s.slackThreads).length, 1);
    assert.deepEqual(reactions().map((call) => [call.body.channel, call.body.timestamp, call.body.name]), [[channel, all(s.slackThreads)[0].ts, "large_orange_square"]]);
    assert.equal(all(s.slackThreads)[0].ts, posts()[1].body.thread_ts);
    } else if (variant === "panel") {
    f.verdicts["gpt-6.2-sol"] = "clean"; f.verdicts["deepseek/deepseek-v4.1-flash"] = "breaking"; f.verdicts.consolidating = "concerns";
    assert.equal(await push("Panel change"), 1);
    const r = await success();
    assert.deepEqual(r.reviewers.map((reviewer) => reviewer.result.verdict).sort(), ["breaking", "clean"]);
    assert.equal(r.result.verdict, "concerns"); assert.deepEqual(reactions().map((call) => [call.body.timestamp, call.body.name]), [["1700000000.000001", "large_orange_square"]]);
    assert.equal(r.reviewers.length, 2); assert.ok(r.reviewers.every((reviewer) => reviewer.result?.outcome === "complete"));
    assert.equal(new Set([...r.reviewers.map((reviewer) => reviewer.piSessionId), r.piSessionId]).size, 3);
    const requests = reviewRequests(), consolidation = requests.filter((request) => request.consolidating);
    assert.equal(new Set(requests.filter((request) => !request.consolidating).map((request) => request.request.model)).size, 2);
    assert.ok(consolidation.length > 0); assert.ok(consolidation.every((request) => !request.text.includes("Grade only from findings") && !request.text.includes("include SCRAT_GRADE")));
    assert.ok(requests.every((request) => request.context.diffBaseSha === previous));
    assert.equal(r.result.grade, undefined); assert.equal(r.result.text, "Consolidated source-verified review.");
    assert.equal(posts().length, 2); assert.equal(posts()[1].body.text, "Consolidated source-verified review."); assert.equal(posts()[1].body.thread_ts, "1700000000.000001");
    assert.equal(f.writes.length, 0);
  } else if (variant === "slack_down") {
    f.verdicts.default = "clean";
    assert.equal(await push("Root down"), 1);
    f.slack.down = true; f.onModel = () => { f.slack.down = false; };
    const first = await success(); f.onModel = undefined;
    assert.equal(posts().length, 3); assert.equal(roots().length, 2);
    assert.equal(posts()[1].body.thread_ts, undefined); assert.equal(posts()[2].body.thread_ts, "1700000000.000001");
    assert.deepEqual(all(s.slackThreads).map((row) => row.ts), ["1700000000.000001"]);
    assert.equal(first.publication.slackReplyTs, "1700000000.000002");
    assert.equal(await push("Reply down", 3), 1);
    const mark = f.slack.calls.length; f.onModel = () => { f.slack.down = true; };
    const failed = await run(); f.onModel = undefined; f.slack.down = false;
    assert.ok(failed.error); assert.equal(failed.stage, "publishing"); assert.equal(failed.publication.slackReplyTs, undefined);
    assert.equal(f.row(s.tasks, failed.taskId).status, "failed"); assert.ok(f.row(s.runs, failed.id).result);
    assert.equal(f.slack.calls.length - mark, 2); assert.equal(all(s.slackThreads).length, 2);
    const used = f.requests.length; tasks.retryTask(failed.taskId);
    const retried = await success();
    assert.equal(f.requests.length, used); assert.equal(retried.retryOfRunId, failed.id); assert.equal(retried.stage, "publishing");
    const added = f.slack.calls.slice(mark).filter((call) => call.method === "chat.postMessage");
    assert.equal(added.length, 3); assert.equal(added.filter((call) => call.body.thread_ts === undefined).length, 1);
    const second = all(s.slackThreads).find((row) => row.subjectId === f.row(s.tasks, failed.taskId).subjectId);
    assert.equal(added[2].body.thread_ts, second.ts); assert.equal(retried.publication.slackReplyTs, "1700000000.000004");
    assert.deepEqual(reactions().map((call) => [call.body.channel, call.body.timestamp, call.body.name]), [[channel, "1700000000.000001", "white_check_mark"], [channel, second.ts, "white_check_mark"]]);
    assert.equal(all(s.slackThreads).length, 2); assert.equal(f.writes.length, 0);
  } else if (variant === "restart") {
    assert.equal(await push("Restart"), 1);
    const claim = tasks.claimTask();
    const { postMessage } = await f.app("slack.ts");
    const ts = await postMessage({ channel, text: "root" });
    db.insert(s.slackThreads).values({ subjectId: claim.subject.id, channel, ts }).run();
    execFileSync(process.execPath, [resolve("app/src/recover.ts"), claim.run.id], { stdio: "pipe" });
    const interrupted = f.row(s.runs, claim.run.id); assert.equal(interrupted.error.code, "RUN_INTERRUPTED");
    tasks.retryTask(interrupted.taskId);
    const done = await success();
    assert.equal(done.retryOfRunId, null); assert.equal(roots().length, 1); assert.equal(posts().length, 2);
    assert.equal(posts()[1].body.thread_ts, ts); assert.equal(all(s.slackThreads).length, 1); assert.equal(done.publication.slackReplyTs, "1700000000.000002");
    assert.equal(reviewRequests().length, 4);
  } else if (variant === "isolation") {
    const token = process.env.SLACK_BOT_TOKEN, { childEnvironment } = await f.app("secrets.ts");
    const probed = readFileSync("isolation.jsonl", "utf8"), writes = f.writes.length;
    assert.equal("SLACK_BOT_TOKEN" in childEnvironment(), false);
    assert.equal(await push("Isolation"), 1);
    const r = await success();
    const requests = reviewRequests(); assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => !JSON.stringify(request.request).includes(token) && !request.text.includes(token)));
    const results = requests.at(-1).request.messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
    assert.equal(results.length, 3);
    assert.ok(results[0].includes("export const value = 2;"));
    assert.ok(results[1].includes("export const value = 1;") && !results[1].includes("value = 2"));
    assert.ok(results[2].includes("src/app.ts | 2"));
    assert.ok(r.result.paths.includes("src/app.ts"));
    assert.equal(readFileSync("isolation.jsonl", "utf8"), probed, "no preparation or validation command ran");
    assert.equal(posts().length, 2); assert.equal(f.writes.length, writes);
  }
};
export const scenarios = {
  item_labels: { title: "optional item labeling backfills independently, uses configured categories, preserves grades, requeues commits and rejects invalid or stale classifications", configure: [(config) => {
    for (const name of ["review_issue", "resolve_conflicts", "address_pr_feedback", "address_review"]) config.workflows[name].enabled = false;
    script(config, "prepare", 'throw new Error("labeling must not run dependency preparation");');
  }], run: async () => {
    const { config: live } = await f.app("config.ts"), settings = live.workflows.label_items;
    // Let the normal grade review prepare, then make preparation fail for classification.
    const prepare = live.workspace.prepare; live.workspace.prepare = [];
    branchOff("human", "src/app.ts", "export const value = 2;\n");
    branchOff("fork", "src/app.ts", "export const value = 3;\n");
    f.addPr(201, "human", "human", { draft: true, labels: [{ name: "keep" }, { name: "risk: high" }, { name: "risk: medium" }] });
    f.addPr(202, "fork", f.config.github.botLogin, { labels: [{ name: "A · Strong" }], head: { ref: "fork", sha: git(resolve("remote.git"), "rev-parse", "fork"), repo: { full_name: "other/fork" } } });
    f.addIssue(1);
    const queued = () => all(s.tasks).filter((task) => task.action === "label_items" && task.status === "queued");
    const names = (item) => item.labels.map((label) => label.name).sort();
    const selections = (entries) => `Classification from the supplied source.\nSCRAT_LABELS: ${JSON.stringify(entries)}\nSCRAT_STATUS: complete`;
    const low = selections([{ category: "risk", name: "risk: low" }]);
    const classify = async (number, responses = [low]) => {
      f.reset(number, "normal");
      f.script = [{ name: "git", args: { operation: "diff", from: "base", to: "head", path: "src/app.ts" } }, ...responses];
      return success();
    };
    await route(); assert.equal(queued().length, 0, "disabled by default");
    await success();
    const comments = f.written("comment").length;
    live.workspace.prepare = prepare;
    settings.enabled = true;
    await route(); await route();
    assert.equal(queued().length, 2, "existing draft, bot and fork PRs backfill, but issues are off");
    assert.ok(queued().every((task) => task.priority === 0));
    touchPr(201); // This commit arrives after queueing, before inference or another sync.
    for (let i = 0; i < 2; i++) {
      f.reset(201, "normal"); f.reset(202, "normal");
      f.script = [{ name: "git", args: { operation: "diff", from: "base", to: "head", path: "src/app.ts" } }, low];
      const labeled = await success();
      assert.equal(labeled.model, "gpt-6.1-terra");
      assert.deepEqual(labeled.result.labels, [{ category: "risk", name: "risk: low" }]);
    }
    assert.deepEqual(names(f.prs[0]), ["B · Solid", "keep", "risk: low"]);
    assert.deepEqual(names(f.prs[1]), ["A · Strong", "risk: low"]);
    await route(); assert.equal(queued().length, 0, "the snapshot actually reviewed is covered even if its queued fingerprint was older");
    assert.equal(f.written("comment").length, comments, "classification posts no review comment");
    const request = f.requests.findLast((entry) => entry.context.action === "label_items");
    assert.deepEqual(request.context.label_categories, settings.config.pr_labels);
    assert.ok(f.requests.some((entry) => entry.context.action === "label_items" && entry.request.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("value = 3"))), "classification can inspect the real fork PR diff");
    live.workflows.review_pr.enabled = false;
    f.comments.set(201, [...f.comments.get(201), humanComment(201, 9901, "A comment alone", "2026-11-07T12:00:00Z")]);
    f.prs[0].labels.push({ name: "unrelated" });
    changeMain("unrelated.txt", "Base tip moved\n");
    await route(); assert.equal(queued().length, 0, "comments, labels and base-tip changes do not requeue");
    live.workflows.resolve_conflicts.enabled = true;
    const savedPrepare = live.workspace.prepare;
    live.workspace.prepare = [];
    const pr201 = all(s.items).find((item) => item.kind === "pr" && item.payload.number === 201);
    tasks.enqueueTask({ subjectId: pr201.id, action: "resolve_conflicts", reason: "Merge main", input: { source: "github_items", kind: "manual", manual: true } });
    const merged201 = await success();
    live.workspace.prepare = savedPrepare;
    f.prs[0].head.sha = merged201.publication.publishedCommitSha;
    live.workflows.resolve_conflicts.enabled = false;
    await route(); assert.equal(queued().length, 0, "pure base-branch conflict merges do not requeue classification");
    // AI-assisted conflict merges (which invoke Pi and may edit PR code) do requeue classification.
    db.update(s.runs).set({ piSessionId: "pi-session-conflict" }).where(eq(s.runs.id, merged201.id)).run();
    await route(); assert.equal(queued().length, 1, "agent-assisted conflict merges requeue classification");
    db.update(s.runs).set({ piSessionId: null }).where(eq(s.runs.id, merged201.id)).run();
    tasks.cancelPendingTasks(pr201.id, "Reset", "label_items");
    touchPr(201); await route(); await route(); assert.equal(queued().length, 1, "new commits coalesce into one task");
    const invalid = selections([{ category: "risk", name: "not-configured" }]);
    await classify(201, [invalid, low]);
    assert.ok(f.requests.at(-1).request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Your previous final answer was not accepted")), "invalid model choices go through format correction");

    // A second category and issue-only targeting use the same task and replace the defaults.
    settings.config.targets = ["issues"];
    settings.model = "gpt-6.2-sol";
    settings.config.issue_labels = [
      { category: "type", choices: [{ name: "type: bug", description: "A reported defect" }, { name: "type: feature", description: "New functionality" }] },
      { category: "scope", choices: [{ name: "scope: product", description: "Product work" }] },
    ];
    await route(); assert.equal(queued().length, 1);
    f.script = [
      selections([{ category: "type", name: "type: bug" }]),
      selections([{ category: "type", name: "type: bug" }, { category: "type", name: "type: feature" }]),
      selections([{ category: "type", name: "type: bug" }, { category: "scope", name: "scope: product" }]),
    ];
    const issue = await success(); assert.equal(issue.model, "gpt-6.2-sol");
    assert.deepEqual(names(f.issues.get(1)), ["scope: product", "type: bug"]);
    assert.deepEqual(f.requests.at(-1).context.label_categories, settings.config.issue_labels);
    await route(); assert.equal(queued().length, 0);
    f.issues.get(1).body += " Updated scope"; await route(); assert.equal(queued().length, 1);
    settings.enabled = false; await route(); assert.equal(queued().length, 0, "disabling cancels queued classification");

    settings.enabled = true; settings.config.targets = ["prs"]; settings.model = "gpt-6.1-terra";
    settings.config.pr_labels[0].choices[0].description += " Narrowly scoped changes.";
    await route(); assert.equal(queued().length, 2, "policy changes backfill previously classified PRs");
    // Keep one PR active so the following checks have an unambiguous next task.
    f.prs[1].state = "closed"; await route(); assert.equal(queued().length, 1);
    settings.config.pr_labels[0].choices[0].description += " Policy updated while queued.";
    assert.ok(tasks.enqueueManualTasks("label_items", ["201"])[0].taskId);
    await classify(201); await route(); assert.equal(queued().length, 0, "manual coalescing does not pin classification to the old policy");
    assert.deepEqual(f.requests.at(-1).context.label_categories, settings.config.pr_labels);
    const before = names(f.prs[0]);
    tasks.enqueueManualTasks("label_items", ["201"]);
    f.onModel = (context) => { if (context.action === "label_items") { f.onModel = undefined; touchPr(201); } };
    f.reset(201, "normal"); f.script = [selections([{ category: "risk", name: "risk: high" }])];
    const stale = await run(); assert.match(stale.error.message, /item changed/i);
    assert.deepEqual(names(f.prs[0]), before, "a stale classification cannot change labels");
    await route(); assert.equal(queued().length, 1);
    await classify(201);
    const itemId = all(s.items).find((item) => item.payload.number === 201).id;
    const manual = tasks.enqueueManualTasks("label_items", ["201"])[0]; assert.ok(manual.taskId);
    await classify(201); await route(); assert.equal(queued().length, 0, "manual classification does not cause an automatic duplicate");
    assert.equal(all(s.tasks).find((task) => task.id === manual.taskId).subjectId, itemId);

    tasks.enqueueManualTasks("label_items", ["201"]);
    f.reset(201, "normal"); f.script = [selections([{ category: "risk", name: "risk: high" }])];
    f.faults.label.add(201);
    const publishing = await run(); assert.ok(publishing.error); assert.equal(publishing.stage, "publishing");
    const requests = f.requests.length, labelsBeforeRetry = names(f.prs[0]);
    settings.config.pr_labels[0].choices[0].description += " Changed after inference.";
    tasks.retryTask(publishing.taskId);
    const outdated = await run(); assert.match(outdated.error.message, /label policy changed/);
    assert.equal(f.requests.length, requests, "publication retry reuses the persisted classification");
    assert.deepEqual(names(f.prs[0]), labelsBeforeRetry, "a saved classification cannot publish under a different policy");
    await route(); assert.equal(queued().length, 1);
    await classify(201); await route(); assert.equal(queued().length, 0);
  } },
  base_only_review: { title: "a re-review caused only by relevant main changes runs the primary reviewer alone with a graded assessment, while every other trigger keeps the panel and retries keep the right plan", configure: [(config) => { config.workflows.resolve_conflicts.enabled = false; }], run: async () => {
    const [primary, secondary] = f.config.workflows.review_pr.reviewers.map((reviewer) => reviewer.model);
    const sessions = (since) => {
      const seen = f.requests.slice(since).filter((r) => r.context.action === "review_pr");
      const count = (predicate) => seen.filter(predicate).length;
      return { primary: count((r) => r.request.model === primary && !r.consolidating), secondary: count((r) => r.request.model === secondary), consolidation: count((r) => r.consolidating) };
    };
    const comments = () => f.botComments(201).length;
    const queued = () => all(s.tasks).filter((t) => t.status === "queued" && t.action === "review_pr");
    const panelRun = (result, since) => {
      const counts = sessions(since);
      assert.equal(result.reviewers.length, 2); assert.equal(result.model, initial.model); assert.ok(counts.primary && counts.secondary && counts.consolidation);
    };
    const singleRun = (result, since) => {
      assert.equal(sessions(since).secondary, 0); assert.equal(sessions(since).consolidation, 0); assert.ok(sessions(since).primary);
      assert.equal(result.reviewers.length, 1); assert.equal(result.reviewers[0].model, primary); assert.equal(result.model, primary);
      assert.equal(result.reviewers[0].result.outcome, "complete"); assert.ok(result.reviewers[0].piSessionId);
      assert.equal(result.result.grade, "B"); assert.equal(result.result.text, result.reviewers[0].result.text);
    };
    await implement(1); await route(); let mark = f.requests.length;
    const initial = await success(); panelRun(initial, mark);
    const branch = f.prs[0].head.ref, subjectId = f.row(s.tasks, initial.taskId).subjectId;

    changeMain("notes.md", "irrelevant\n"); await route(); assert.equal(queued().length, 0);

    changeMain("src/app.ts", "export const value = 99;\n"); await route();
    assert.equal(queued().length, 1); assert.equal(queued()[0].input.baseOnly, true);
    mark = f.requests.length; const single = await success(); singleRun(single, mark);
    assert.equal(comments(), 1); assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);

    const updates = f.written("comment_update").length;
    changeMain("src/app.ts", "export const value = 98;\n"); await route(); assert.equal(queued()[0].input.baseOnly, true);
    await success(); assert.equal(f.written("comment_update").length, updates, "a re-review with unchanged text does not edit the comment");

    changeMain("src/app.ts", "export const value = 100;\n"); await route(); assert.equal(queued()[0].input.baseOnly, true);
    pushFile(branch, "human-note.txt", "A follow-up change\n"); await route();
    assert.equal(queued().length, 1); assert.equal(queued()[0].input.baseOnly, undefined, "coalescing with a head change drops the base-only reason");
    mark = f.requests.length; panelRun(await success(), mark);

    changeMain("src/app.ts", "export const value = 101;\n"); await route(); assert.equal(queued()[0].input.baseOnly, true);
    tasks.enqueueTask({ subjectId, action: "review_pr", reason: "Manual review", input: { source: "github_items", kind: "manual", manual: true } });
    mark = f.requests.length; panelRun(await success(), mark);

    changeMain("src/app.ts", "export const value = 102;\n"); f.comments.get(201).push(humanComment(201, 9100, "Please look at the edge case", "2026-10-19T02:00:00Z")); await route();
    assert.equal(queued()[0].input.baseOnly, undefined, "a context change with a main change is mixed");
    mark = f.requests.length; panelRun(await success(), mark);

    changeMain("src/app.ts", "export const value = 104;\n"); await route();
    f.faults.comment.add(201); const lost = await run(); assert.equal(lost.stage, "publishing"); assert.ok(lost.error); assert.equal(lost.reviewers.length, 1);
    mark = f.requests.length; tasks.retryTask(lost.taskId); const recovered = await success();
    assert.equal(f.requests.length, mark); assert.deepEqual(recovered.reviewers, lost.reviewers); assert.equal(recovered.result.text, lost.result.text);
    assert.equal(recovered.publication.status, "published");

    changeMain("src/app.ts", "export const value = 103;\n"); await route();
    f.reset(201, "incomplete"); const failed = await run(); assert.equal(failed.error.code, "AGENT_INCOMPLETE"); assert.equal(failed.reviewers.length, 1);
    f.reset(201, "normal"); mark = f.requests.length; tasks.retryTask(failed.taskId); singleRun(await success(), mark);

    changeMain("src/app.ts", "export const value = 105;\n"); await route();
    f.reset(201, "incomplete"); const stale = await run(); assert.ok(stale.error);
    pushFile(branch, "second-note.txt", "Another follow-up\n");
    f.reset(201, "normal"); mark = f.requests.length; tasks.retryTask(stale.taskId); panelRun(await success(), mark);
  } },
  queue: { title: "SQLite queue coalesces input, orders priorities, excludes busy workspaces and caps six tasks", run: async () => {
    for (let n = 1; n <= 9; n++) f.addIssue(n);
    f.enqueue(1); f.enqueue(2, "implement"); const first = f.enqueue(3, "review_pr", { source: "github_items", kind: "manual", version: 1 });
    const coalesced = f.enqueue(3, "review_pr", { source: "github_items", kind: "manual", version: 2 });
    assert.equal(coalesced.id, first.id); assert.equal(coalesced.input.version, 2);
    assert.equal(tasks.claimTask().task.action, "review_pr");
    assert.equal(tasks.claimTask().task.action, "implement");
    for (let n = 4; n <= 9; n++) f.enqueue(n);
    for (let n = 0; n < 4; n++) assert.ok(tasks.claimTask());
    assert.equal(tasks.claimTask(), undefined);
    assert.equal(all(s.tasks).filter((t) => t.status === "running").length, 6);
    for (const r of all(s.runs)) tasks.finishRun(r.id, { status: "completed" });
    const { createWorkspace } = await f.app("workspaces.ts");
    const { fetchRepository } = await f.app("git.ts");
    await fetchRepository(f.config.github.repositoryPath, "https://github.com/fixture/project.git", "main");
    const w = await createWorkspace({ repositoryPath: f.config.github.repositoryPath, baseRef: "origin/main" });
    db.update(s.subjects).set({ workspaceId: w.id }).where(eq(s.subjects.id, "issue-8")).run();
    db.update(s.subjects).set({ workspaceId: w.id }).where(eq(s.subjects.id, "issue-9")).run();
    const claimed = []; let next; while ((next = tasks.claimTask())) claimed.push(next);
    assert.equal(claimed.filter((c) => ["issue-8", "issue-9"].includes(c.item.id)).length, 1);
  } },
  routing: { title: "GitHub routing reconciles all five actions and coalesces changing facts without invoking Pi", run: async () => {
    f.addIssue(1); f.addIssue(2, ["scrat"]); await route();
    const queued = () => all(s.tasks).filter((t) => t.status === "queued");
    assert.deepEqual(queued().map((t) => t.action).sort(), ["implement", "review_issue"]);
    await route(); assert.equal(queued().length, 2);
    f.issues.get(1).labels.push({ name: "scrat" }); f.issues.get(2).labels = []; await route();
    assert.deepEqual(queued().map((t) => [t.subjectId, t.action]).sort(), [["issue-1", "implement"], ["issue-2", "review_issue"]]);
    branchOff("scrat/routing", "src/app.ts", "export const value = 2;\n");
    changeMain("src/app.ts", "export const value = 3;\n");
    branchOff("scrat/clean", "src/clean.ts", "export const clean = 1;");
    f.addPr(201, "scrat/routing", f.config.github.botLogin, { node_id: "PR_routing", title: f.issues.get(1).title, body: "Closes #1" });
    f.addPr(202, "scrat/clean", "human", { node_id: "PR_clean", title: "Clean PR", body: "" });
    const external = humanComment(201, 9001, "Please explain this change", "2026-10-19T01:00:00Z");
    f.comments.set(201, [external, { ...external, id: 9002, body: "My own review", user: { login: f.config.github.botLogin } }]);
    await route();
    assert.ok(!queued().some((t) => t.subjectId === "issue-1"));
    const prTasks = (number = 201) => queued().filter((t) => { const item = f.row(s.items, t.subjectId); return item?.kind === "pr" && item.payload.number === number; });
    assert.deepEqual(prTasks(201).map((t) => t.action).sort(), ["address_pr_feedback", "resolve_conflicts"], "pending conflict refresh suppresses PR review");
    assert.deepEqual(prTasks(202).map((t) => t.action), ["review_pr"]);
    const conflict = prTasks(201).find((t) => t.action === "resolve_conflicts"), feedback = prTasks(201).find((t) => t.action === "address_pr_feedback");
    assert.deepEqual(feedback.input.commentRevisions, ["issue:9001@2026-10-19T01:00:00Z"]);
    changeMain("src/app.ts", "export const value = 4;\n");
    external.updated_at = "2026-10-19T02:00:00Z"; await route();
    assert.equal(prTasks().find((t) => t.action === "resolve_conflicts").id, conflict.id);
    assert.notEqual(prTasks().find((t) => t.action === "resolve_conflicts").input.mainSha, conflict.input.mainSha);
    assert.equal(prTasks().find((t) => t.action === "address_pr_feedback").id, feedback.id);
    assert.deepEqual(prTasks().find((t) => t.action === "address_pr_feedback").input.commentRevisions, ["issue:9001@2026-10-19T02:00:00Z"]);
    f.comments.set(201, [f.comments.get(201)[1]]); await route();
    assert.ok(!prTasks().some((t) => t.action === "address_pr_feedback"));
    f.prs[0].state = "closed"; f.prs[1].state = "closed"; await route(); assert.equal(prTasks(201).length + prTasks(202).length, 0);
    assert.equal(f.requests.length, 0, "Routing does not require agent inference");
  } },
  repository_sync: { title: "repository sync bounds reads, shares scoped authentication, refreshes expired tokens and keeps raw diagnostics", run: async () => {
    for (let number = 1; number <= 8; number++) f.addIssue(number);
    f.addIssue(9, ["scrat"]);
    f.issues.get(1).diagnosticOnly = { retained: true };
    const fetch = globalThis.fetch, exchanges = [], credentials = new Map(), revoked = new Set();
    const { mock } = await import("node:test");
    let active = 0, peak = 0, fail = false;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/access_tokens")) {
        const exchange = JSON.parse(options.body); exchanges.push(exchange);
        const response = await fetch(input, options), data = await response.clone().json();
        credentials.set(data.token, { ...exchange, expiresAt: Date.parse(data.expires_at) });
        return response;
      }
      if (url.hostname === "api.github.com" && url.pathname !== "/app") {
        const token = bearer(options);
        if (!credentials.has(token) || credentials.get(token).expiresAt <= Date.now() || revoked.has(token)) {
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } });
        }
      }
      const read = options.method === "GET" && /\/issues\/\d+(?:\/comments)?$/.test(url.pathname);
      if (!read) return fetch(input, options);
      active++; peak = Math.max(peak, active);
      try {
        await new Promise((done) => setTimeout(done, 15));
        if (fail && url.pathname.endsWith("/issues/3/comments")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
        return await fetch(input, options);
      } finally { active--; }
    };
    try {
      await route();
      assert.ok(peak > 1 && peak <= 4, `Expected bounded concurrent reads, saw ${peak}`);
      assert.equal(all(s.tasks).filter((task) => task.status === "queued").length, 9);
      assert.equal(f.row(s.items, "issue-1").payload.diagnosticOnly, undefined);
      const count = (permission) => exchanges.filter((exchange) => JSON.stringify(exchange.permissions) === JSON.stringify(permission)).length;
      const read = { issues: "read", pull_requests: "read", metadata: "read" }, contents = { contents: "read", metadata: "read" };
      assert.equal(count(read), 1); assert.equal(count(contents), 1);
      await route(); assert.equal(count(read), 1); assert.equal(count(contents), 1);
      mock.timers.enable({ apis: ["Date"], now: Date.now() });
      mock.timers.tick(60 * 60 * 1000);
      await route(); assert.equal(count(read), 2); assert.equal(count(contents), 2);
      const implemented = await success(); assert.equal(implemented.publication.pullRequestNumber, 209);
      assert.equal(count({ contents: "write", metadata: "read" }), 1);
      assert.equal(count({ pull_requests: "write", contents: "read", metadata: "read" }), 1);
      const { GitHubRepository } = await f.app("github.ts");
      const github = new GitHubRepository("fixture/project"), write = { issues: "write", pull_requests: "write", metadata: "read" };
      await github.addLabels(1, ["human-note"]);
      const writeToken = [...credentials].find(([, entry]) => JSON.stringify(entry.permissions) === JSON.stringify(write))[0];
      revoked.add(writeToken); const writes = f.writes.length;
      await assert.rejects(github.addLabels(1, ["another-note"]), (error) => error.status === 401);
      assert.equal(f.writes.length, writes); assert.equal(count(write), 1, "Do not replay a failed write with new credentials");
      await github.addLabels(1, ["another-note"]);
      assert.equal(count(write), 2); assert.equal(count(read), 2, "Refresh only the revoked scope");
      assert.ok(f.issues.get(1).labels.some((label) => label.name === "another-note"));
      fail = true;
      await assert.rejects(route(), (error) => error.status === 404);
      assert.equal(active, 0, "A failed sync must wait for its other in-flight readers");
    } finally { mock.timers.reset(); globalThis.fetch = fetch; }
  } },
  sync_cost: { title: "one fresh observation per PR, list-reused issue metadata, ETag 304s, rate-limit deferral and no duplicate review under routing/publication races", run: async () => {
    await implement(1); await implement(2); f.addIssue(10); f.addIssue(11);
    const { GitHubRepository } = await f.app("github.ts");
    const reads = (since) => f.calls.slice(since).filter((call) => call.method === "GET" && !call.path.endsWith("/access_tokens"));
    const count = (since, pattern) => reads(since).filter((call) => pattern.test(call.path)).length;
    let since = f.calls.length;
    await route();
    for (const number of [201, 202]) {
      assert.ok(count(since, new RegExp(`/pulls/${number}$`)) <= 1);
      assert.ok(count(since, new RegExp(`/issues/${number}/comments`)) <= 1);
      assert.ok(count(since, new RegExp(`/pulls/${number}/(comments|reviews)`)) <= 2);
    }
    for (const number of [10, 11]) {
      assert.equal(count(since, new RegExp(`/issues/${number}$`)), 0);
      assert.ok(count(since, new RegExp(`/issues/${number}/comments`)) <= 1);
    }
    since = f.calls.length; await route();
    assert.ok(reads(since).length > 0);
    assert.deepEqual(reads(since).filter((call) => call.status !== 304), []);
    const remaining = f.rate.remaining; await route(); assert.equal(f.rate.remaining, remaining, "304s do not consume the rate limit");
    f.comments.set(202, [humanComment(202, 900, "Please rename this", "2026-10-19T02:00:00Z", "c900")]);
    since = f.calls.length; await route();
    assert.equal(reads(since).find((call) => call.path.includes("/issues/202/comments")).status, 200);
    assert.equal(reads(since).find((call) => call.path.includes("/issues/201/comments")).status, 304);
    assert.ok(all(s.tasks).some((task) => task.action === "address_pr_feedback" && f.row(s.items, task.subjectId).payload.number === 202));
    const comment = (id) => ({ id, body: "c" + id, user: { login: "human" }, updated_at: "2026-10-19T02:00:00Z", html_url: "https://github.com/fixture/project/issues/10#c" + id });
    f.comments.set(10, Array.from({ length: 100 }, (_, i) => comment(1000 + i)));
    const github = new GitHubRepository("fixture/project");
    assert.equal((await github.fetchItemContext("issue", 10, { item: f.issues.get(10) })).comments.length, 100);
    f.comments.get(10).push(comment(1100));
    since = f.calls.length;
    assert.equal((await github.fetchItemContext("issue", 10, { item: f.issues.get(10) })).comments.length, 101);
    assert.deepEqual(reads(since).map((call) => call.status), [200, 200]);
    since = f.calls.length;
    assert.equal((await github.fetchItemContext("issue", 10, { item: f.issues.get(10) })).comments.length, 101);
    assert.deepEqual(reads(since).map((call) => call.status), [200, 304]);
    f.rate.remaining = 100; since = f.calls.length; await route();
    assert.equal(count(since, /\/comments|\/reviews|\/pulls\/\d+$/), 0);
    assert.ok(count(since, /\/issues\?/) > 0);
    f.rate.remaining = 5000; f.rate.reset++; since = f.calls.length; await route();
    assert.ok(count(since, /\/issues\/10\/comments/) > 0);
    {
      const original = globalThis.fetch;
      let active = 0, failing = true;
      globalThis.fetch = async (input, options = {}) => {
        const { pathname } = new URL(input);
        if (!/\/(pulls|issues)\/201/.test(pathname)) return original(input, options);
        active++;
        try {
          await new Promise((done) => setTimeout(done, 15));
          if (failing && pathname.endsWith("/pulls/201/reviews")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
          return await original(input, options);
        } finally { active--; }
      };
      try {
        f.comments.set(201, [humanComment(201, 901, "Changed so reads are not 304", "2026-10-19T03:00:00Z", "c901")]);
        await assert.rejects(github.fetchItemContext("pr", 201), (error) => error.status === 404);
        assert.equal(active, 0, "A failed PR read must wait for its sibling reads");
        failing = false; await route();
      } finally { globalThis.fetch = original; }
    }
    const fetch = globalThis.fetch;
    let blocked, release;
    const held = new Promise((done) => { blocked = done; }), released = new Promise((done) => { release = done; });
    let once = false;
    globalThis.fetch = async (input, options = {}) => {
      const response = await fetch(input, options);
      if (!once && (options.method ?? "GET") === "GET" && new URL(input).pathname.endsWith("/issues/201/comments")) { once = true; blocked(); await released; }
      return response;
    };
    try {
      const syncing = route(); await held;
      const working = run();
      while (!all(s.runs).some((r) => r.result && !r.finishedAt)) await new Promise((done) => setTimeout(done, 10));
      for (let turn = 0; turn < 50; turn++) await new Promise((done) => setImmediate(done));
      release();
      const [, published] = await Promise.all([syncing, working]);
      assert.equal(published.error, null, JSON.stringify(published.error));
      assert.equal(f.written("comment", (write) => write.number === 201).length, 1);
      assert.equal(f.botComments(201).length, 1);
      await route(); assert.equal(f.botComments(201).length, 1);
    } finally { release(); globalThis.fetch = fetch; }
  } },
  routing_history: { title: "covered triggers and attempts skip unavailable review history, and an item whose routing throws is logged without blocking later items", run: async () => {
    f.addIssue(1); f.enqueue(1); const completed = await success();
    changeMain("src/app.ts", "export const value = 2;\n"); await route();
    db.update(s.runs).set({ mainSha: "f".repeat(40) }).where(eq(s.runs.id, completed.id)).run();
    const isQueued = (id) => all(s.tasks).some((t) => t.subjectId === id && t.status === "queued");
    f.addIssue(2); await route(); assert.ok(isQueued("issue-2"));
    const claim = tasks.claimTask(); assert.equal(claim.task.subjectId, "issue-1");
    tasks.finishRun(claim.run.id, { status: "failed", error: new Error("Interrupted before inference") });
    f.addIssue(3); await route(); assert.ok(isQueued("issue-3")); assert.ok(!isQueued("issue-1"));
    for (const id of ["issue-2", "issue-3"]) tasks.cancelPendingTasks(id, "Isolate manual review attempt");
    f.enqueue(1); f.reset(1, "incomplete"); const failed = await run();
    assert.equal(failed.error.code, "AGENT_INCOMPLETE");
    assert.equal(f.row(s.tasks, failed.taskId).input.triggerKey, undefined);
    const calls = f.requests.length; f.addIssue(4); await route();
    assert.ok(isQueued("issue-4")); assert.ok(!isQueued("issue-1")); assert.equal(f.requests.length, calls);
    changeMain("src/app.ts", "export const value = 3;\n"); f.addIssue(5);
    const lines = captureLogs();
    try { await route(); } finally { restoreLogs(); }
    assert.ok(isQueued("issue-5"), "an item whose history cannot be compared does not stop routing for the others");
    assert.ok(lines.some((line) => line.event === "github.routing_failed" && line.subjectId === "issue-1"));
  } },
  acceptance: { title: "action postconditions reject empty implementations and unresolved conflicts but permit reply-only feedback", run: async () => {
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement"); f.reset(1, "no-change");
    const empty = await success(); assert.equal(f.prs.length, 0); assert.equal(empty.publication.status, "published");
    assert.equal(empty.publication.publishedCommitSha, undefined); assert.equal(f.row(s.tasks, empty.taskId).status, "completed");
    assert.equal(f.comments.get(1).length, 1); assert.match(f.comments.get(1)[0].body, /^Implemented the change\./);
    assert.ok(f.comments.get(1)[0].body.trimEnd().endsWith(`<!-- scrat-task:${empty.taskId} -->`));
    await route(); assert.deepEqual(all(s.tasks).filter((t) => t.subjectId === "issue-1").map((t) => t.status), ["completed"]);
    assert.ok(f.row(s.workspaces, empty.workspaceId).removedAt); assert.equal(f.row(s.subjects, "issue-1").workspaceId, null);
    f.issues.get(1).labels = []; await route(); f.issues.get(1).labels = [{ name: "scrat" }]; await route();
    const requeued = all(s.tasks).filter((t) => t.subjectId === "issue-1" && t.status === "queued");
    assert.deepEqual(requeued.map((t) => t.action), ["implement"]);
    f.issues.get(1).labels = []; await route(); assert.deepEqual(all(s.tasks).filter((t) => t.subjectId === "issue-1" && t.action === "implement" && t.status === "queued"), []);
    let calls = f.requests.length;
    const implemented = await implement(2); const head = f.prs[0].head.sha;
    changeMain("src/app.ts", "export const value = 99;\n"); await route();
    const prItem = all(s.items).find((i) => i.kind === "pr");
    tasks.cancelPendingTasks(prItem.id, "Exercise conflict postcondition directly", "review_pr");
    f.reset(202, "no-change"); const unresolved = await run();
    assert.match(unresolved.error.message, /still conflicts/); assert.equal(f.prs[0].head.sha, head);
    calls = f.requests.length; tasks.retryTask(unresolved.taskId, "validation");
    const stillConflicted = await run(); assert.match(stillConflicted.error.message, /still conflicts/); assert.equal(f.requests.length, calls);
    assert.ok(!f.row(s.workspaces, implemented.workspaceId).removedAt);
    tasks.enqueueTask({ subjectId: prItem.id, action: "address_pr_feedback", reason: "Reply without code changes", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(202, "no-change"); const replied = await success();
    assert.equal(replied.publication.publishedCommitSha, head); assert.equal(f.prs.length, 1);
    assert.equal(f.comments.get(202).length, 1); assert.equal(replied.workspaceId, implemented.workspaceId);
  } },
  panel: { title: "Scrat-authored PR gets two independent Pi sessions and one consolidated comment", seed: seedIgnore, configure: [configurePanel, (config) => { config.workflows.resolve_conflicts.enabled = false; }], run: async () => {
    const implemented = await implement(1); f.prs[0].labels.push({ name: "human-label" }); await route();
    const review = await success();
    assert.equal(review.reviewers.length, 2);
    assert.deepEqual(review.reviewers.map((r) => r.model), ["gpt-6.2-sol", "deepseek/deepseek-v4.1-flash"]);
    assert.equal(new Set([...review.reviewers.map((r) => r.piSessionId), review.piSessionId]).size, 3);
    assert.ok(review.reviewers.every((r) => r.result?.outcome === "complete"));
    for (const model of ["gpt-6.2-sol", "deepseek/deepseek-v4.1-flash"]) {
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("9.8.7"))), "Reviewer must read the prepared dependency in its own workspace");
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const value = 1;"))), "Reviewer must read the immutable base file, not the modified head");
    }
    for (const request of f.requests.filter((r) => r.context.action === "review_pr")) {
      assert.deepEqual(request.context.diffPaths, ["src/app.ts"]); assert.match(request.context.diffBaseSha, /^[a-f0-9]{40}$/);
    }
    assert.equal(f.written("comment", (w) => w.number === 201).length, 1);
    assert.match(f.comments.get(201)[0].body, /Consolidated/);
    assert.equal(review.result.grade, "B");
    const prompts = (request) => request.request.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n");
    const toolText = (request, text) => request.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes(text));
    for (const request of f.requests) {
      assert.ok(!prompts(request).includes("diff --git"), "No model prompt may embed a patch"); assert.ok(!("diff" in request.context) && !("mainChanges" in request.context));
    }
    const panel = f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating);
    const consolidation = f.requests.filter((r) => r.consolidating);
    for (const model of ["gpt-6.2-sol", "deepseek/deepseek-v4.1-flash"]) {
      const mine = panel.filter((r) => r.request.model === model).at(-1);
      assert.ok(toolText(mine, "src/app.ts | 2"), "diff_stat output reaches the model");
      assert.ok(toolText(mine, "node_modules/"), "show reads the immutable base file");
      assert.ok(toolText(mine, "diff --git") && toolText(mine, "truncated: bytes 0-20"), "capped diff pages");
      assert.ok(toolText(mine, "[]"), "The agent can read its context directory");
      assert.ok(toolText(mine, "must be repository-relative"), "option-like paths are rejected");
      for (const message of ["revision must be a 7-40 character lowercase hex commit SHA"]) assert.ok(toolText(mine, message), message);
      assert.ok(toolText(mine, "revision is required for show; use a 7-40 character lowercase hex"), "show without revision names the operation and accepted forms");
      assert.ok(toolText(mine, "Path is outside the workspace"), "reads outside the worktree and run directory stay refused");
    }
    assert.ok(consolidation.some((r) => toolText(r, "Independent review from")), "consolidator reads reviewer report files");
    assert.ok(!consolidation.some((r) => prompts(r).includes("Independent review from")));
    assert.ok(review.reviewers.every((r) => r.result.paths.includes(".gitignore")), "git show records its path in scope");
    assert.ok(review.result.paths.every((path) => !path.startsWith("./")) && review.reviewers.every((r) => r.result.paths.every((path) => !path.startsWith("./"))), "paths are canonical");
    assert.ok(review.result.paths.includes(".gitignore") && review.result.paths.every((path) => !path.includes("runs")));
    for (const run of [implemented, review]) {
      const directory = resolve("data/runs", run.id);
      assert.ok(existsSync(resolve(directory, "discussion.json")));
      if (run === implemented) assert.ok(!git(f.row(s.workspaces, run.workspaceId).path, "ls-files").includes("discussion"));
    }
    assert.equal(git(resolve("remote.git"), "ls-tree", "-r", "--name-only", f.prs[0].head.ref), ".gitignore\nsrc/app.ts");
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["B · Solid", "human-label"]);
    for (const req of f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating)) assert.ok(!req.text.includes("Independent review from"));
    f.comments.get(201)[0].body = f.comments.get(201)[0].body.replace("<!-- scrat-review -->\n", "");
    f.reset(201, "grade-A");
    changeMain("src/app.ts", "export const value = 99;\n");
    for (let n = 0; n < 250; n++) writeFileSync(resolve("seed", `src/many-${n}.txt`), `${n}\n`);
    git(resolve("seed"), "add", "."); commit(resolve("seed"), "Many files"); git(resolve("seed"), "push", resolve("remote.git"), "main");
    changeMain("src/bulk.txt", Array.from({ length: 30000 }, (_, n) => `bulk line ${n}`).join("\n") + "\n"); await route();
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["human-label"]);
    f.faults.label.add(201); const failed = await run(); assert.ok(failed.error); const calls = f.requests.length;
    tasks.retryTask(failed.taskId); const rereview = await success(); assert.equal(f.requests.length, calls);
    assert.equal(rereview.publication.commentId, review.publication.commentId);
    const second = f.requests.filter((r) => r.context.revision && r.context.previous);
    assert.ok(second.length >= 3 && second.every((r) => prompts(r).length < 20_000), "Prompt size is independent of base-branch changes");
    assert.ok(second.every((r) => /^[a-f0-9]{40}$/.test(r.context.previous.mainSha) && r.context.previous.mainSha !== r.context.workspace.mainSha));
    assert.ok(!failed.result.paths.includes("src/bulk.txt"), "Files looked at only because main changed them stay out of review scope");
    assert.ok(failed.result.paths.includes("src/app.ts"));
    assert.ok(second.some((r) => toolText(r, "src/bulk.txt")));
    for (const r of second) {
      assert.ok(!("changedPaths" in r.context.input) && r.context.input.changedPathCount >= 250);
      assert.ok(readFileSync(r.context.files.changedPaths, "utf8").split("\n").includes("src/many-249.txt"));
    }
    assert.equal(f.botComments(201).length, 1);
    assert.equal(f.written("comment_update").length, 1);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
    const itemId = f.row(s.tasks, review.taskId).subjectId;
    f.reset(201, "normal"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Manual review", input: { source: "github_items", kind: "manual", manual: true } });
    f.faults.label.add(201); const older = await run(); assert.ok(older.error);
    f.reset(201, "grade-A"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Newer manual review", input: { source: "github_items", kind: "manual", manual: true } });
    await success(); const writes = f.writes.length, inferences = f.requests.length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.writes.length, writes); assert.equal(f.requests.length, inferences);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
  } },
  canonical: { title: "publication recovery and re-review preserve the recorded comment when feedback quotes its markers", run: async () => {
    await implement(1); await route(); f.faults.comment.add(201);
    const lost = await run(); assert.ok(lost.error); assert.equal(lost.stage, "publishing");
    const original = f.comments.get(201)[0];
    const feedback = { ...original, id: 9000, body: "Feedback quoting the review:\n```\n" + original.body + "\n```\n<!-- scrat-task:feedback -->" };
    f.comments.get(201).push(feedback);
    const calls = f.requests.length; tasks.retryTask(lost.taskId); const recovered = await success();
    assert.equal(f.requests.length, calls); assert.equal(recovered.publication.commentId, original.id);
    f.reset(201, "grade-A");
    tasks.enqueueTask({ subjectId: f.row(s.tasks, lost.taskId).subjectId, action: "review_pr", reason: "New assessment", input: { source: "github_items", kind: "manual", manual: true } });
    f.faults.comment.add(201); const lostUpdate = await run(); assert.ok(lostUpdate.error);
    assert.deepEqual(f.prs[0].labels, [], "A lost report-write response must not leave the old report's grade");
    const updateCalls = f.requests.length; tasks.retryTask(lostUpdate.taskId); const updated = await success();
    assert.equal(f.requests.length, updateCalls); assert.equal(updated.publication.commentId, original.id);
    assert.equal(f.comments.get(201).length, 2); assert.equal(f.comments.get(201)[1].body, feedback.body);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
  } },
  deleted_review: { title: "deleted canonical comments are restored from the authoritative saved assessment", run: () => deletedReview("deleted") },
  unreceipted_review: { title: "older retries preserve a newer remote review even when its write receipt was lost", run: () => deletedReview("unreceipted") },
  stale_assessment: { title: "a stale newest assessment clears its grade without resurrecting an older narrower review", run: async () => {
    changeMain("src/helper.ts", "export const helper = 1;\n");
    await implement(1); await route(); f.faults.label.add(201);
    const older = await run(); assert.ok(older.error);
    const itemId = f.row(s.tasks, older.taskId).subjectId;
    f.reset(201, "helper-grade-A");
    tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Broader fresh review", input: { source: "github_items", kind: "manual", manual: true } });
    const newer = await success();
    assert.ok(newer.result.paths.includes("src/helper.ts"));
    const report = f.comments.get(201)[0].body;
    changeMain("src/helper.ts", "export const helper = 2;\n");
    const calls = f.requests.length; await route();
    assert.deepEqual(f.prs[0].labels, [], "No historical grade may replace a stale newer grade");
    assert.equal(f.comments.get(201)[0].body, report);
    assert.ok(all(s.tasks).some((t) => t.subjectId === itemId && t.action === "review_pr" && t.status === "queued"));
    tasks.cancelPendingTasks(itemId, "Exercise an explicitly requested old publication retry", "review_pr");
    tasks.retryTask(older.taskId); const stale = await run();
    assert.match(stale.error.message, /fresh review/);
    assert.equal(f.requests.length, calls); assert.deepEqual(f.prs[0].labels, []);
    assert.equal(f.comments.get(201)[0].body, report);
  } },
  manual_queue: { title: "manual tasks survive routing cancels and coalescing, run as normal authoritative reviews, die with their item, and enqueue by number", run: async () => {
    await implement(1); await route(); await success();
    const prItem = all(s.items).find((i) => i.kind === "pr"), itemId = prItem.id;
    const reviewTasks = () => all(s.tasks).filter((t) => t.subjectId === itemId && t.action === "review_pr");
    await route(); assert.equal(reviewTasks().filter((t) => t.status === "queued").length, 0, "review is current");
    const [ok, missing] = [tasks.enqueueManualTasks("review_pr", ["201", String(prItem.payload.number)], 77), tasks.enqueueManualTasks("review_pr", ["999", "Nope"])];
    assert.equal(ok[0].error, undefined); assert.equal(ok[0].itemId, itemId); assert.equal(ok[0].number, 201);
    assert.equal(ok[1].taskId, ok[0].taskId, "same item coalesces");
    assert.equal(missing.length, 2); assert.ok(missing.every((r) => /No item/.test(r.error)));
    assert.throws(() => tasks.enqueueManualTasks("bogus", ["201"]), /Unknown action/);
    const manual = f.row(s.tasks, ok[0].taskId);
    assert.equal(manual.input.manual, true); assert.equal(manual.priority, 77);
    await route();
    assert.equal(f.row(s.tasks, manual.id).status, "queued", "routing must not cancel a manual task");
    tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Routing", input: { source: "github_items", kind: "item_changed", triggerKey: "k", revision: "r", mainSha: "m", changedPaths: [] } });
    const merged = f.row(s.tasks, manual.id);
    assert.equal(merged.status, "queued"); assert.deepEqual(merged.input, { source: "github_items", kind: "item_changed", triggerKey: "k", revision: "r", mainSha: "m", changedPaths: [], manual: true });
    await route(); assert.equal(f.row(s.tasks, manual.id).status, "queued");
    const result = await success();
    assert.equal(result.taskId, manual.id);
    assert.equal(result.publication.status, "published");
    await route(); assert.equal(reviewTasks().filter((t) => t.status === "queued").length, 0, "the manual run is the current authoritative review");
    const again = tasks.enqueueManualTasks("review_pr", ["201"])[0];
    f.prs[0].state = "closed"; await route();
    assert.equal(f.row(s.tasks, again.taskId).status, "cancelled");
    assert.equal(tasks.enqueueManualTasks("review_pr", ["201"])[0].error, "Item is closed");
    f.addIssue(5); const mixed = tasks.enqueueManualTasks("review_issue", ["5", "404", "issue-5"]);
    assert.deepEqual(mixed.map((r) => Boolean(r.taskId)), [true, false, true]);
    assert.equal(mixed[0].taskId, mixed[2].taskId);
    await implement(2); await route();
    const item2 = all(s.items).find((i) => i.kind === "pr" && i.payload.number === 202).id;
    const reviews2 = () => all(s.tasks).filter((t) => t.subjectId === item2 && t.action === "review_pr");
    const routed = reviews2().find((t) => t.status === "queued"); assert.ok(routed.input.triggerKey);
    const merge = tasks.enqueueManualTasks("review_pr", ["202"])[0];
    assert.equal(merge.taskId, routed.id);
    assert.deepEqual(f.row(s.tasks, routed.id).input, { ...routed.input, manual: true });
    await success(); await route();
    const [prOnIssue] = tasks.enqueueManualTasks("review_pr", ["5"]), [issueOnPr] = tasks.enqueueManualTasks("review_issue", ["202"]);
    assert.match(prOnIssue.error, /review_pr needs a PR/); assert.match(issueOnPr.error, /review_issue needs an issue/);
    assert.match(tasks.enqueueManualTasks("implement", ["202"])[0].error, /needs an issue/);
    assert.match(tasks.enqueueManualTasks("resolve_conflicts", ["5"])[0].error, /needs a PR/);
    assert.match(tasks.enqueueManualTasks("address_pr_feedback", ["5"])[0].error, /needs a PR/);
    assert.ok(!all(s.tasks).some((t) => t.subjectId === "issue-5" && t.action === "review_pr"));
    f.prs.find((pr) => pr.number === 202).title = "Retitled after the review"; await route();
    assert.deepEqual(reviews2().filter((t) => t.status === "queued"), [], "a description edit is not a context change");
    touchPr(202);
    const running = tasks.enqueueManualTasks("review_pr", ["202"])[0];
    const claimed = tasks.claimTask(); assert.equal(claimed.task.id, running.taskId);
    await route();
    assert.deepEqual(reviews2().filter((t) => t.status === "queued"), [], "a running manual review covers the sync");
  } },
  working_notes: { title: "change sessions keep working notes in an excluded workspace file that never reaches a commit; reviews are not told to", run: async () => {
    f.addIssue(1, ["scrat"]); f.reset(1, "notes"); f.enqueue(1, "implement"); const r = await success();
    const notes = resolve(f.row(s.workspaces, r.workspaceId).path, ".scrat/notes.md");
    const system = ({ request }) => JSON.stringify(request.messages.filter((m) => m.role === "system" || m.role === "developer"));
    const change = f.requests.filter((entry) => entry.context.action === "implement");
    assert.ok(change.length && change.every((entry) => system(entry).includes(notes.replaceAll("\\", "\\\\"))), "Every change request carries the notes path");
    assert.ok(change.every((entry) => system(entry).includes("its validation or the commit state")));
    assert.equal(readFileSync(notes, "utf8"), "Plan: change value\n");
    const commit = r.publication.publishedCommitSha;
    assert.deepEqual(git(resolve("remote.git"), "ls-tree", "-r", "--name-only", commit).split("\n").filter((path) => path.startsWith(".scrat")), []);
    assert.match(git(resolve("remote.git"), "show", `${commit}:src/app.ts`), /value = 5/);
    await route(); await success();
    const reviews = f.requests.filter((entry) => entry.context.action === "review_pr");
    assert.ok(reviews.length && reviews.every((entry) => !system(entry).includes(".scrat/notes.md")));
  } },
  implement_base_moved: { title: "a retried implementation whose retained workspace began on an older base moves up to the current base first", configure: [configureCheck], run: async () => {
    changeMain("fail-validation", "fail\n"); const oldBase = git(resolve("remote.git"), "rev-parse", "main");
    f.addIssue(1); f.enqueue(1, "implement"); const failed = await run();
    f.addIssue(2); f.enqueue(2, "implement"); const overlapping = await run();
    assert.equal(failed.error.exitCode, 7); assert.equal(overlapping.error.exitCode, 7); assert.equal(f.prs.length, 0);
    git(resolve("seed"), "rm", "-q", "fail-validation"); commit(resolve("seed"), "Remove marker");
    git(resolve("seed"), "push", resolve("remote.git"), "main");
    const base = git(resolve("remote.git"), "rev-parse", "main");
    tasks.retryTask(failed.taskId); const retried = await success();
    assert.equal(retried.retryOfRunId, failed.id); assert.equal(retried.mainSha, base);
    assert.equal(git(resolve("remote.git"), "rev-parse", `${retried.publication.publishedCommitSha}^`), base, "The retry commits on the current base");
    assert.equal(f.prs.length, 1); assert.equal(f.row(s.workspaces, retried.workspaceId).baseSha, base);
    changeMain("src/app.ts", "export const value = 99;\n");
    const stuck = f.row(s.workspaces, overlapping.workspaceId);
    tasks.retryTask(overlapping.taskId); const kept = await run();
    assert.equal(kept.error.exitCode, 7); assert.equal(git(stuck.path, "rev-parse", "HEAD"), oldBase);
    assert.match(readFileSync(resolve(stuck.path, "src/app.ts"), "utf8"), /value = 12/); assert.equal(f.row(s.workspaces, stuck.id).baseSha, oldBase);
  } },
  run_sequence: { title: "claims assign increasing run sequences that stay unique", run: async () => {
    for (let n = 1; n <= 5; n++) f.addIssue(n);
    f.enqueue(1); f.enqueue(2, "implement");
    const claims = [tasks.claimTask(), tasks.claimTask()];
    assert.deepEqual(claims.map((c) => c.task.action), ["implement", "review_issue"]);
    assert.deepEqual(claims.map((c) => c.run.sequence), [1, 2]);
    for (const c of claims) tasks.finishRun(c.run.id, { status: "completed" });
    for (let n = 3; n <= 5; n++) f.enqueue(n);
    const more = [tasks.claimTask(), tasks.claimTask(), tasks.claimTask()].map((c) => c.run);
    assert.deepEqual(more.map((r) => r.sequence), [3, 4, 5]);
    for (const r of more) tasks.finishRun(r.id, { status: "completed" });
    assert.throws(() => db.$client.exec("UPDATE runs SET sequence = 1 WHERE sequence = 2"), /UNIQUE/);
  } },
  assessment_order: { title: "new inference on an old task outranks newer-created tasks regardless of timestamps", run: async () => {
    await implement(1); await route(); f.reset(201, "incomplete");
    const failed = await run(); assert.ok(failed.error); assert.notEqual(failed.stage, "publishing");
    const itemId = f.row(s.tasks, failed.taskId).subjectId;
    f.reset(201, "normal"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "New task", input: { source: "github_items", kind: "manual", manual: true } });
    const middle = await success();
    f.reset(201, "grade-A"); tasks.retryTask(failed.taskId); const newest = await success();
    assert.ok(newest.sequence > middle.sequence);
    assert.equal(newest.result.grade, "A");
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
    assert.match(f.comments.get(201)[0].body, new RegExp(newest.taskId));
    const calls = f.requests.length; await route();
    assert.equal(f.requests.length, calls);
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
  } },
  run_latest: { title: "the latest run is chosen by claim sequence for issue baselines and Pi session continuation", run: async () => {
    changeMain("src/helper.ts", "export const helper = 1;\n");
    f.addIssue(1); await route(); const first = await success(); assert.ok(first.result.paths.includes("src/app.ts"));
    f.enqueue(1); f.reset(1, "helper");
    const second = await success(); assert.ok(second.result.paths.includes("src/helper.ts")); assert.ok(second.sequence > first.sequence);
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.action === "review_issue" && t.status === "queued"), "The latest claimed review is the baseline");
    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement"); const implemented = await success();
    const prItem = all(s.items).find((i) => i.kind === "pr");
    const feedback = async (mode = "no-change") => { tasks.enqueueTask({ subjectId: prItem.id, action: "address_pr_feedback", reason: "Reply", input: { source: "github_items", kind: "manual", manual: true } }); f.reset(202, mode); return mode === "no-change" ? success() : run(); };
    const separate = await feedback("no-change"); assert.equal(separate.workspaceId, implemented.workspaceId);
    assert.notEqual(separate.piSessionFile, implemented.piSessionFile, "Distinct actions on one workspace start fresh Pi sessions");
    const failed = await feedback("incomplete");
    assert.equal(failed.result.outcome, "incomplete");
    const copy = failed.piSessionFile.replace(/\.jsonl$/, "-copy.jsonl");
    copyFileSync(failed.piSessionFile, copy);
    db.update(s.runs).set({ piSessionFile: resolve("pruned-release", basename(copy)) }).where(eq(s.runs.id, failed.id)).run();
    tasks.retryTask(failed.taskId); f.reset(202, "no-change");
    const retried = await success();
    assert.equal(retried.piSessionFile, realpathSync(copy), "Same-task retry resumes its latest claimed session file");
    assert.ok(retried.sequence > failed.sequence);
  } },
  scope_snapshots: { title: "PR-only, renamed and deleted paths keep their identities across unrelated base changes", seed: seedScopeSnapshots, configure: [configureScopeSnapshots, (config) => { config.workflows.resolve_conflicts.enabled = false; }], run: async () => {
    const implemented = await implement(1), workspace = f.row(s.workspaces, implemented.workspaceId);
    unlinkSync(workspace.path + "/src/deleted.ts");
    git(workspace.path, "mv", "src/renamed.ts", "src/moved.ts");
    writeFileSync(workspace.path + "/src/added.ts", "export const added = 1;\n");
    git(workspace.path, "add", "."); commit(workspace.path, "Prepare PR additions, deletions and rename");
    git(workspace.path, "push", resolve("remote.git"), workspace.branch);
    await route(); let changed = false;
    f.onModel = () => { if (!changed) { changed = true; changeMain("notes.md", "Unrelated during review\n"); } };
    const reviewed = await success(); f.onModel = undefined;
    assert.ok(!reviewed.result.paths.includes("."));
    for (const path of ["src/added.ts", "src/deleted.ts", "src/renamed.ts", "src/moved.ts", " leading.ts", "src/generated.ts"]) assert.ok(reviewed.result.paths.includes(path), path);
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool"
      && JSON.stringify(m.content).includes("export const deleted = 1;\\n"))), "Base reads preserve the deleted source blob, including whitespace");
    changeMain("notes.md", "Unrelated after review\n"); await route();
    assert.ok(!all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
    changeMain(" leading.ts", "export const leading = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
    f.reset(201, "normal"); await success();
    changeMain("src/deleted.ts", "export const deleted = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
  } },
  grade_race: { title: "sync invalidation and publication reconcile one current PR grade under concurrent execution", run: async () => {
    await implement(1); await route(); const reviewed = await success();
    tasks.enqueueTask({ subjectId: f.row(s.tasks, reviewed.taskId).subjectId, action: "review_pr", reason: "Fresh review", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(201, "normal"); changeMain("src/app.ts", "export const value = 99;\n");
    let unblock, sawRemoval, sawPublicationContext;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const removal = new Promise((resolve) => { sawRemoval = resolve; });
    const context = new Promise((resolve) => { sawPublicationContext = resolve; });
    const fetch = globalThis.fetch, before = f.requests.length;
    let held = false;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!held && options.method === "DELETE" && url.pathname.includes("/issues/201/labels/")) {
        held = true; sawRemoval(); await blocked;
      }
      const response = await fetch(input, options);
      if (url.pathname.endsWith("/pulls/201") && f.requests.slice(before).some((r) => r.consolidating)) sawPublicationContext();
      return response;
    };
    try {
      const syncing = route(); await removal;
      const working = run(); await context; unblock();
      const [, published] = await Promise.all([syncing, working]);
      assert.equal(published.error, null, JSON.stringify(published.error));
      assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    } finally { unblock(); globalThis.fetch = fetch; }
  } },
  grade_failure: { title: "grade delivery failures cannot prevent durable review tasks or block other PRs", run: async () => {
    await implement(1); await implement(2); await route(); await success(); await success();
    changeMain("src/app.ts", "export const value = 99;\n");
    f.faults.label.add(201); await route();
    for (const number of [201, 202]) assert.ok(all(s.tasks).some((t) => t.status === "queued" && f.row(s.items, t.subjectId).payload.number === number));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    await route(); assert.deepEqual(f.prs[0].labels, []);
  } },
  absent_labels: { title: "already absent labels reconcile without errors and without hiding access failures", run: async () => {
    f.addIssue(1); const { reconcileLabels } = await f.app("labels.ts");
    const { GitHubRepository } = await f.app("github.ts");
    const request = () => reconcileLabels(new GitHubRepository("fixture/project"), 1, { current: ["scrat"], desired: [], managed: ["scrat"] });
    await reconcileLabels(new GitHubRepository("fixture/project"), 1, { current: ["scrat", "B"], desired: [], managed: ["scrat", "B"] });
    assert.deepEqual(f.written("label", (w) => w.method === "DELETE").map((w) => w.name), ["scrat", "B"]);
    f.issues.get(1).labels = [{ name: "scrat" }];
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => options.method === "DELETE"
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }) : fetch(input, options);
    try { await assert.rejects(request(), (error) => error.status === 404); }
    finally { globalThis.fetch = fetch; }
    f.issues.delete(1);
    await assert.rejects(request(), (error) => error.status === 404);
  } },
  publish_effects: { title: "publication kinds apply an ordered list of effect primitives and skip each one whose receipt is already recorded", configure: [configureCommitSource], run: async () => {
    const { pollCommits } = await f.app("commit-source.ts");
    const seed = resolve("seed"), remote = resolve("remote.git"), pushLog = resolve("pushes.log");
    writeFileSync(resolve(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> "${pushLog}"\n`, { mode: 0o755 });
    const pushes = () => existsSync(pushLog) ? readFileSync(pushLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const trace = [], record = f.writes.push.bind(f.writes);
    f.writes.push = (write) => { trace.push({ type: write.type, pushes: pushes() }); return record(write); };
    const types = (from) => trace.slice(from).map((entry) => entry.type);
    const preset = (saved, receipts) => db.update(s.runs).set({ publication: { ...saved.publication, ...receipts } }).where(eq(s.runs.id, saved.id)).run();
    const posts = () => f.slack.calls.filter((call) => call.method === "chat.postMessage");
    const pushMain = (message, value) => {
      writeFileSync(resolve(seed, "src/app.ts"), `export const value = ${value};\n`); git(seed, "add", "."); commit(seed, message);
      git(seed, "push", remote, "main"); return pollCommits();
    };
    assert.equal(await pollCommits(), 0);
    assert.equal(await pushMain("First", 2), 1);
    const first = await success();
    assert.deepEqual(posts().map((call) => call.body.thread_ts === undefined ? "root" : "reply"), ["root", "reply"]);
    assert.equal(first.publication.slackReplyTs, "1700000000.000002"); assert.equal(first.publication.status, "published");
    assert.equal(await pushMain("Second", 3), 1);
    f.onModel = () => { f.slack.down = true; };
    const slackFailed = await run(); f.onModel = undefined; f.slack.down = false;
    assert.ok(slackFailed.error); assert.equal(slackFailed.stage, "publishing");
    preset(slackFailed, { slackReplyTs: "1700000000.000099" });
    const slackMark = f.slack.calls.length; tasks.retryTask(slackFailed.taskId);
    const slackRetried = await success();
    assert.equal(f.slack.calls.length, slackMark, "a receipted Slack reply is not posted again");
    assert.equal(slackRetried.publication.slackReplyTs, "1700000000.000099"); assert.equal(slackRetried.publication.status, "published");

    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
    const implemented = await success();
    assert.deepEqual(types(0), ["pr"]); assert.ok(trace[0].pushes > 0, "the branch is pushed before the PR is created");
    assert.equal(implemented.publication.status, "published");
    const pr = all(s.items).find((item) => item.kind === "pr");
    changeMain("other.txt", "other\n");
    let mark = trace.length, pushed = pushes();
    tasks.enqueueTask({ subjectId: pr.id, action: "resolve_conflicts", reason: "Exercise comment publication", input: { source: "github_items", kind: "manual", manual: true } });
    const merged = await success();
    assert.deepEqual(types(mark), ["comment"]);
    assert.ok(trace[mark].pushes > pushed, "the merge is pushed before the comment is posted");
    assert.equal(merged.publication.status, "published");
    changeMain("another.txt", "another\n");
    f.faults.comment.add(201); mark = trace.length;
    tasks.enqueueTask({ subjectId: pr.id, action: "resolve_conflicts", reason: "Exercise comment receipt", input: { source: "github_items", kind: "manual", manual: true } });
    const lost = await run(); assert.ok(lost.error); assert.equal(lost.stage, "publishing");
    assert.deepEqual(types(mark), ["comment"]);
    assert.equal(lost.publication.publishedCommitSha, lost.publication.commitSha);
    preset(lost, { commentId: f.comments.get(201).at(-1).id });
    mark = trace.length; pushed = pushes(); tasks.retryTask(lost.taskId);
    const recovered = await success();
    assert.deepEqual(types(mark), [], "a receipted comment is not written again"); assert.equal(pushes(), pushed);
    assert.equal(recovered.publication.status, "published");

    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement"); f.faults.pr.add(2); mark = trace.length;
    const prLost = await run(); assert.ok(prLost.error);
    assert.deepEqual(types(mark), ["pr"]);
    assert.equal(prLost.publication.publishedCommitSha, prLost.publication.commitSha);
    preset(prLost, { pullRequestNumber: 202 });
    mark = trace.length; pushed = pushes(); tasks.retryTask(prLost.taskId);
    const prRecovered = await success();
    assert.deepEqual(types(mark), [], "a receipted PR is not created again"); assert.equal(pushes(), pushed);
    assert.equal(prRecovered.publication.pullRequestNumber, 202); assert.equal(f.prs.length, 2);

    f.addIssue(3, ["human-label"]); f.reset(3, "ready"); f.enqueue(3); mark = trace.length;
    await success();
    assert.equal(types(mark)[0], "comment"); assert.equal(types(mark).filter((type) => type === "comment").length, 1);
    assert.ok(types(mark).slice(1).length > 0); assert.ok(types(mark).slice(1).every((type) => type === "label"), "comment first, then labels");
    f.addIssue(4, ["human-label"]); f.reset(4, "ready"); f.enqueue(4); f.faults.label.add(4); mark = trace.length;
    const labelFailed = await run(); assert.ok(labelFailed.error);
    assert.equal(types(mark)[0], "comment"); assert.ok(labelFailed.publication.commentId);
    mark = trace.length; tasks.retryTask(labelFailed.taskId);
    await success();
    assert.ok(types(mark).length > 0); assert.ok(types(mark).every((type) => type === "label"), "a receipted comment is skipped and labels still reconcile");

    await route(); const settled = trace.length, slackSettled = f.slack.calls.length;
    const review = await success();
    assert.equal(f.row(s.tasks, review.taskId).action, "review_pr"); assert.equal(review.publication.status, "published");
    assert.equal(types(settled).filter((type) => type === "comment").length, 1, "the review is published as one comment");
    assert.equal(f.slack.calls.length, slackSettled);
  } },
  reviewer_failure: { title: "a terminal reviewer failure posts one recoverable notice without publishing a partial assessment", run: async () => {
    await implement(2); await route(); f.reset(202, "reviewer-failure"); f.faults.comment.add(202);
    const r = await run(); assert.ok(r.error); assert.ok(r.reviewers.some((r) => r.error));
    assert.equal(f.requests.filter((r) => r.consolidating).length, 0);
    const notice = () => (f.comments.get(202) ?? []).find((comment) => comment.body.includes("<!-- scrat-review -->"));
    assert.match(notice()?.body ?? "", /review failed/i);
    assert.match(notice().body, /agent/); assert.match(notice().body, new RegExp(r.taskId));
    const commentId = notice().id, written = f.written("comment").length;
    const quoted = "Feedback quoting the failed review:\n```\n" + notice().body + "\n```";
    f.comments.get(202).push({ ...notice(), id: 9000, body: quoted });
    await route(); await route();
    assert.equal(f.written("comment").length, written, "unchanged failures do not repost");
    assert.equal(f.comments.get(202)[1].body, quoted, "quoted failure markers never identify the notice");
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
    f.reset(202, "missing-grade"); tasks.retryTask(r.taskId);
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.equal(notice().id, commentId, "a second failure updates the existing notice");
    assert.match(notice().body, /grade/i);
    f.reset(202, "normal"); tasks.retryTask(r.taskId);
    const recovered = await success();
    assert.equal(recovered.publication.commentId, commentId);
    assert.doesNotMatch(notice().body, /review failed/i);
    assert.equal(f.comments.get(202).length, 2, "the notice and quoted feedback are retained without duplicates");
    const config = (await f.app("config.ts")).config;
    config.providers.fixture.api = "openai-responses";
    (await f.app("model-runtime.ts")).dropModelRuntime();
    touchPr(202); await route();
    const malformed = await run();
    for (const reviewer of malformed.reviewers) {
      assert.equal(reviewer.error.name, "TypeError");
      assert.match(reviewer.error.stack, /processResponsesStream/);
      assert.equal(JSON.parse(reviewer.error.evidence).responseId, "fixture-stream-error");
      const saved = readFileSync(reviewer.piSessionFile, "utf8").trim().split("\n").map(JSON.parse)
        .findLast((entry) => entry.message?.stopReason === "error");
      assert.match(saved.message.errorStack, /processResponsesStream/);
    }
    assert.match(notice().body, /review failed/i);
    assert.doesNotMatch(notice().body, /processResponsesStream/);
    assert.equal(notice().id, commentId);
  } },
  review_retry: { title: "a review whose reviewers all fail transiently is held until due and publishes once after recovery, while a mixed panel stays failed, and a dropped consolidation retries only the consolidation", configure: [(config) => { config.harness.agentRetry.maxRetries = 1; config.workflows.review_pr.retry = { initialDelaySeconds: 60, maxDelaySeconds: 100 }; }], run: async () => {
    await implement(2); await route(); f.transient.failures = 4; f.reset(202, "transient");
    let failed = await run(); const task = () => f.row(s.tasks, failed.taskId);
    const delay = () => (Date.parse(task().availableAt) - Date.parse(f.row(s.runs, failed.id).finishedAt)) / 1000;
    assert.equal(failed.error.code, "TRANSIENT_INFERENCE"); assert.equal(task().status, "queued"); const first = delay();
    assert.equal(await f.runNextTask(), undefined, "a requeued review is not claimed before it is due");
    const id = task().id; await route();
    assert.equal(all(s.tasks).filter((t) => t.status === "queued").length, 1); assert.equal(await f.runNextTask(), undefined);
    tasks.retryTask(id); assert.equal(all(s.tasks).filter((t) => t.status === "queued").length, 1);
    failed = await run(); assert.equal(failed.error.code, "TRANSIENT_INFERENCE"); assert.equal(task().status, "queued");
    const second = delay(); assert.ok(second >= 1.5 * first, `backoff grows: ${first} then ${second}`); assert.ok(second <= 100.1, `backoff stays within maxDelaySeconds: ${second}`);
    assert.equal(await f.runNextTask(), undefined, "a second failure is also held until due");
    assert.equal(f.written("comment").length, 0);
    tasks.enqueueTask({ subjectId: task().subjectId, action: "review_pr", reason: "Changed", input: { source: "github_items", kind: "manual", manual: true } });
    const reviewed = await success(); assert.equal(reviewed.taskId, id);
    assert.equal(task().status, "completed"); assert.equal(f.written("comment").length, 1);
    await implement(3); await route(); f.transient.failures = 100; f.reset(203, "transient-mixed");
    const mixed = await run(); assert.ok(mixed.error); assert.notEqual(mixed.error.code, "TRANSIENT_INFERENCE");
    assert.equal(f.row(s.tasks, mixed.taskId).status, "failed");
    await implement(4); await route(); f.reset(204, "reviewer-failure");
    const permanent = await run(); assert.ok(permanent.error); assert.equal(f.row(s.tasks, permanent.taskId).status, "failed");
    assert.equal(permanent.reviewers[0].result?.outcome, "complete"); assert.equal(permanent.reviewers[1].result, undefined);
    // Partial reviewer reuse: retrying after 1 of 2 reviewers completed reruns only the failed reviewer and consolidation.
    const beforePartial = f.requests.length;
    f.reset(204, "normal"); tasks.retryTask(permanent.taskId);
    const partial = await success();
    const partialModels = f.requests.slice(beforePartial).filter((r) => !r.consolidating).map((r) => r.request.model);
    assert.ok(partialModels.length > 0 && partialModels.every((model) => model === partial.reviewers[1].model), `only the incomplete reviewer reruns: ${partialModels}`);
    assert.ok(all(s.events).some((event) => event.type === "run.reviewers_reused" && event.runId === partial.id && event.data.fromRunId === permanent.id));
    await implement(5); await route(); f.transient.failures = 100; f.reset(205, "transient");
    const closing = await run(); assert.equal(f.row(s.tasks, closing.taskId).status, "queued");
    f.prs.find((pr) => pr.number === 205).state = "closed"; await route();
    assert.equal(f.row(s.tasks, closing.taskId).status, "cancelled"); assert.equal(await f.runNextTask(), undefined);
    await implement(6); await route(); f.reset(206, "dropped-consolidation");
    const dropped = await run(); assert.equal(dropped.error.code, "TRANSIENT_INFERENCE"); assert.equal(f.row(s.tasks, dropped.taskId).status, "queued");
    const requested = f.requests.length; tasks.retryTask(dropped.taskId);
    const consolidated = await success(); assert.deepEqual(consolidated.reviewers, dropped.reviewers);
    assert.ok(f.requests.slice(requested).length && f.requests.slice(requested).every((request) => request.consolidating), "the retry reruns only the consolidation");
    assert.ok(all(s.events).some((event) => event.type === "run.reviewers_reused" && event.runId === consolidated.id && event.data.fromRunId === dropped.id));
    // Interrupted panel review (retryOfRunId=null after crash/drain) also reuses completed reviewers on the same revision.
    await implement(7); await route();
    const pr7 = f.prs.find((pr) => pr.number === 207);
    const interruptedClaim = tasks.claimTask();
    db.update(s.runs).set({
      stage: "agent", mainSha: git(resolve("remote.git"), "rev-parse", "main"), headSha: pr7.head.sha,
      context: { revision: (await f.app("observation.ts")).observe(await (new (await f.app("github.ts")).GitHubRepository(f.config.github.repository)).fetchItemContext("pr", 207)).revision, baseBranch: "main", commentRevisions: [], headSha: pr7.head.sha },
      reviewers: [partial.reviewers[0], interruptedClaim.run.reviewers[1]],
    }).where(eq(s.runs.id, interruptedClaim.run.id)).run();
    tasks.interruptRun(interruptedClaim.run.id);
    const beforeInterruptedReuse = f.requests.length;
    f.reset(207, "normal");
    const resumedPanel = await success();
    assert.equal(resumedPanel.retryOfRunId, null);
    const resumedModels = f.requests.slice(beforeInterruptedReuse).filter((r) => !r.consolidating).map((r) => r.request.model);
    assert.ok(resumedModels.length > 0 && resumedModels.every((model) => model === resumedPanel.reviewers[1].model), "interrupted panel review reuses completed reviewer without retryOfRunId");
    assert.ok(all(s.events).some((event) => event.type === "run.reviewers_reused" && event.runId === resumedPanel.id && event.data.fromRunId === interruptedClaim.run.id));
    // Active in-flight PR review supersession: a new PR head aborts the running review immediately without a failure notice, while unrelated main pushes and comment-only edits do not.
    pr7.head.sha = pushFile(pr7.head.ref, "src/supersede-1.ts", "export const s = 1;\n");
    await route();
    f.reset(207, "stall");
    let triggered = false, phase = "initial", settledPhase, triggerPromise;
    f.onModel = (context) => {
      if (triggered || context.item?.number !== 207) return;
      triggered = true;
      triggerPromise = (async () => {
        phase = "main";
        changeMain("notes.md", "unrelated main move during active review\n");
        await route();
        await new Promise((done) => setTimeout(done, 50));
        phase = "comment";
        f.comments.set(207, [...(f.comments.get(207) ?? []), humanComment(207, 9901, "Sticky CI status update", "2026-11-21T01:00:00Z")]);
        await route();
        await new Promise((done) => setTimeout(done, 50));
        phase = "head";
        pr7.head.sha = pushFile(pr7.head.ref, "src/supersede-2.ts", "export const s = 2;\n");
        await route();
      })();
    };
    const commentsBeforeSupersede = f.written("comment", (w) => w.number === 207).length;
    const superseded = await run().then((result) => { settledPhase = phase; return result; }); f.onModel = undefined;
    await triggerPromise;
    assert.equal(settledPhase, "head", "only the PR head change—not main drift or comments—superseded the review");
    assert.equal(superseded.error?.name, "SupersededError");
    assert.equal(superseded.error?.code, "RUN_SUPERSEDED");
    assert.equal(superseded.error?.message, "Newer PR head or base observed");
    assert.equal(f.row(s.tasks, superseded.taskId).status, "cancelled");
    assert.equal(f.written("comment", (w) => w.number === 207).length, commentsBeforeSupersede, "superseded review posts no failure notice");
    f.reset(207, "normal");
    const latestReview = await success();
    assert.equal(latestReview.headSha, pr7.head.sha, "newly queued review for the latest PR head completes cleanly");
    // Pre-inference freshness skip: an already-queued non-manual review whose PR is now current cancels immediately without calling the model.
    const pr7SubjectId = f.row(s.tasks, latestReview.taskId).subjectId;
    const requestsBeforeSkip = f.requests.length;
    tasks.enqueueTask({
      subjectId: pr7SubjectId, action: "review_pr", priority: 200, reason: "Queued before earlier run finished",
      input: { source: "github_items", kind: "item_changed", triggerKey: "stale-queued", revision: "stale", mainSha: latestReview.mainSha, changedPaths: [] },
    });
    const skippedReview = await run();
    assert.equal(f.requests.length, requestsBeforeSkip, "pre-inference freshness skip makes zero model requests");
    assert.equal(skippedReview.error?.code, "RUN_SUPERSEDED");
    assert.equal(f.row(s.tasks, skippedReview.taskId).status, "cancelled");
    // Manual review of the same current PR is never skipped.
    const requestsBeforeManual = f.requests.length;
    tasks.enqueueTask({
      subjectId: pr7SubjectId, action: "review_pr", priority: 200, reason: "Manual re-review",
      input: { source: "github_items", kind: "item_changed", manual: true, triggerKey: "manual-current", revision: "stale", mainSha: latestReview.mainSha, changedPaths: [] },
    });
    const manualReview = await success();
    assert.ok(f.requests.length > requestsBeforeManual, "manual PR review runs even when already current");
    // Blocked PR pre-inference skip: cancelling with RUN_SUPERSEDED keeps the blocked state intact on subsequent routing.
    db.update(s.runs).set({ result: null }).where(eq(s.runs.id, latestReview.id)).run();
    db.update(s.runs).set({ result: null, error: { name: "Error", code: "BRANCH_CONFLICT", message: "PR conflicts with base" } }).where(eq(s.runs.id, manualReview.id)).run();
    const requestsBeforeBlocked = f.requests.length;
    tasks.enqueueTask({
      subjectId: pr7SubjectId, action: "review_pr", priority: 200, reason: "Queued before conflict failure",
      input: { source: "github_items", kind: "item_changed", triggerKey: "stale-blocked", revision: "stale", mainSha: manualReview.mainSha, changedPaths: [] },
    });
    const skippedBlocked = await run();
    assert.equal(f.requests.length, requestsBeforeBlocked, "blocked PR pre-inference skip makes zero model requests");
    assert.equal(skippedBlocked.error?.code, "RUN_SUPERSEDED");
    assert.equal(skippedBlocked.error?.message, "PR conflicts with its base branch; waiting for a new head");
    const queuedBeforeRoute = all(s.tasks).filter((t) => t.subjectId === pr7SubjectId && t.action === "review_pr" && t.status === "queued").length;
    await route();
    assert.equal(all(s.tasks).filter((t) => t.subjectId === pr7SubjectId && t.action === "review_pr" && t.status === "queued").length, queuedBeforeRoute, "RUN_SUPERSEDED skip does not mask BRANCH_CONFLICT on subsequent sync");
  } },
  footer: { title: "quoted control markers stay report text and cannot supply a PR grade or issue approval", run: async () => {
    await implement(1); f.reset(201, "quoted-grade"); await route();
    const reviewed = await success();
    assert.equal(reviewed.result.grade, "A");
    assert.match(f.comments.get(201)[0].body, /```\nSCRAT_GRADE: F\nSCRAT_READY\n```/);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.reset(201, "quoted-only");
    tasks.enqueueTask({ subjectId: f.row(s.tasks, reviewed.taskId).subjectId, action: "review_pr", reason: "Review again", input: { source: "github_items", kind: "manual", manual: true } });
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.addIssue(2); f.reset(2, "quoted-only"); f.enqueue(2);
    const issue = await success(); assert.equal(issue.result.ready, false);
    assert.deepEqual(f.issues.get(2).labels, []);
  } },
  format_retry: { title: "malformed final footers are corrected inside the same Pi session up to a cap, while implementations and undecided outcomes are not, and an incomplete review is continued within its budget", run: async () => {
    f.addIssue(1, ["scrat"]); f.reset(1, "format-once"); f.enqueue(1, "implement");
    let before = f.requests.length; const implemented = await success();
    assert.ok(f.requests.length - before >= 2 && f.requests.length - before <= 4, "the malformed footer was sent back to the agent once");
    assert.equal(implemented.result.outcome, "complete");
    const reviewCounts = () => {
      const counts = {};
      for (const r of f.requests.filter((r) => r.context.action === "review_pr")) { const k = `${r.request.model}/${r.consolidating}`; counts[k] = (counts[k] ?? 0) + 1; }
      return counts;
    };
    await route(); const first = await success();
    const normal = reviewCounts();
    assert.equal(Object.keys(normal).length, 3);
    for (const [mode, target] of [["reviewer-grade-once", "deepseek/deepseek-v4.1-flash/false"], ["consolidation-grade-once", "gpt-6.2-sol/true"]]) {
      const start = reviewCounts(); f.reset(201, mode);
      tasks.enqueueTask({ subjectId: f.row(s.tasks, first.taskId).subjectId, action: "review_pr", reason: "Review again", input: { source: "github_items", kind: "manual", manual: true } });
      const reviewed = await success(); const end = reviewCounts();
      for (const k of Object.keys(normal)) assert.ok(end[k] - (start[k] ?? 0) >= normal[k] + (k === target ? 1 : 0) && end[k] - (start[k] ?? 0) <= normal[k] + 2, `${mode} ${k}`);
      assert.equal(reviewed.result.grade, "B");
      assert.ok(reviewed.result.paths.includes("src/app.ts"));
      assert.ok(reviewed.reviewers.every((r) => !r.error));
    }
    f.addIssue(2); f.reset(2, "no-status"); f.enqueue(2, "implement");
    before = f.requests.length; const stuck = await run();
    assert.match(stuck.error.message, /SCRAT_STATUS/); assert.ok(f.requests.length - before >= 2 && f.requests.length - before <= 4);
    assert.equal(f.row(s.tasks, stuck.taskId).status, "failed");
    assert.ok(existsSync(f.row(s.workspaces, stuck.workspaceId).path + "/src/app.ts"));
    const prsBefore = f.prs.length, writesBefore = f.writes.length;
    for (const [i, [mode, least, most]] of [["incomplete", 0, 2], ["needs_decision", 0, 2], ["bare-status", 2, 4]].entries()) {
      f.addIssue(i + 3); f.reset(i + 3, mode); f.enqueue(i + 3, "implement");
      before = f.requests.length; const r = await run(); assert.ok(r.error);
      assert.ok(f.requests.length - before >= least && f.requests.length - before <= most, mode);
      assert.equal(f.row(s.tasks, r.taskId).status, "failed");
      assert.ok(existsSync(f.row(s.workspaces, r.workspaceId).path + "/src/app.ts"));
    }
    assert.equal(f.prs.length, prsBefore); assert.equal(f.writes.length, writesBefore);
    const prompts = () => f.requests.filter((r) => r.request.messages.at(-1).role === "user" && JSON.stringify(r.request.messages.at(-1).content).includes("Your assessment was returned incomplete")).length;
    const publications = () => f.writes.length;
    f.reset(201, "incomplete-once"); tasks.enqueueTask({ subjectId: f.row(s.tasks, first.taskId).subjectId, action: "review_pr", reason: "Continue", input: { source: "github_items", kind: "manual", manual: true } });
    let writes = publications(); const continued = await success();
    assert.equal(continued.result.outcome, "complete"); assert.ok(prompts() >= 3); assert.equal(publications() - writes, 0, "an unchanged review and grade write nothing");
    const published = f.comments.get(201).length;
    f.reset(201, "incomplete"); tasks.enqueueTask({ subjectId: f.row(s.tasks, first.taskId).subjectId, action: "review_pr", reason: "Never completes", input: { source: "github_items", kind: "manual", manual: true } });
    writes = publications(); const spent = prompts(); const exhausted = await run();
    assert.match(exhausted.error.cause.message, /Reviewer returned incomplete/); assert.equal(publications(), writes); assert.equal(f.comments.get(201).length, published);
    assert.ok(prompts() > spent);
    f.reset(201, "needs_decision"); tasks.enqueueTask({ subjectId: f.row(s.tasks, first.taskId).subjectId, action: "review_pr", reason: "Undecided", input: { source: "github_items", kind: "manual", manual: true } });
    const asked = prompts(); await run(); assert.equal(prompts(), asked);
    f.addIssue(6); f.reset(6, "incomplete-once"); f.enqueue(6, "implement");
    const partial = await run(); assert.ok(partial.error); assert.equal(prompts(), asked);
  } },
  pr_head: { title: "a stale refs/pull head is replaced by the API head, and a head the remote lacks fails the run without pushing", run: async () => {
    await implement(1);
    const remote = resolve("remote.git"), branch = f.prs[0].head.ref, stale = git(remote, "rev-parse", branch);
    f.frozen.add(201);
    const newer = git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", branch + "^{tree}", "-p", branch, "-m", "Newer head");
    git(remote, "update-ref", "refs/heads/" + branch, newer);
    await route();
    assert.equal(git(remote, "rev-parse", "refs/pull/201/head"), stale);
    const reviewed = await success();
    assert.equal(reviewed.headSha, newer);
    const { fetchPullRequestHead } = await f.app("git.ts");
    assert.equal(await fetchPullRequestHead(resolve("checkout"), resolve("missing.git"), 201, newer), newer, "A matching local ref needs no fetch");
    await assert.rejects(fetchPullRequestHead(resolve("checkout"), resolve("missing.git"), 201, stale), /fetch/);
    const heads = git(remote, "for-each-ref", "refs/heads");
    f.forced.set(201, "0".repeat(40)); tasks.enqueueManualTasks("review_pr", ["201"]);
    const failed = await run();
    assert.match(failed.error.message, /PR #201 head 0{40} could not be fetched/);
    assert.equal(git(remote, "for-each-ref", "refs/heads"), heads);
    await implement(2); await route();
    const second = all(s.items).find((i) => i.kind === "pr" && i.payload.number === 202);
    assert.ok(all(s.tasks).some((t) => t.subjectId === second.id && t.action === "review_pr" && t.status === "queued"));
  } },
  verification: { title: "verification receipts bind to the published commit and failing checks block publication", configure: [configureCheck], run: async () => {
    const r = await implement(1);
    assert.equal(r.verification.headSha, r.publication.publishedCommitSha);
    assert.match(r.verification.commands[0].tail, /checked actual source/); assert.equal(r.verification.commands[0].status, "passed"); assert.match(readFileSync(r.verification.commands[0].evidence[0], "utf8"), /checked actual source/);
    assert.equal(git(resolve("remote.git"), "rev-parse", f.prs[0].head.ref), r.verification.headSha);
    changeMain("fail-validation", "fail\n");
    f.addIssue(2); f.enqueue(2, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(f.prs.length, 1); assert.equal(failed.verification, null);
    assert.equal(failed.error.exitCode, 7);
    assert.match(failed.error.stdout, /validation detail \[redacted\]/);
    assert.match(failed.error.stdout, /Verification failed/);
    assert.match(failed.error.evidence, new RegExp(`^${RegExp.escape(resolve("data/checks", failed.id))}/validate-0-\\d+\\.log$`));
    assert.match(readFileSync(failed.error.evidence, "utf8"), /Verification failed/);
    assert.ok(!JSON.stringify(failed.error).includes("ghs_fixture_sensitive"));
  } },
  validation_mutation: { title: "checks that change source cannot certify the resulting commit", configure: [configureCheck], run: async () => {
    f.addIssue(1); f.enqueue(1, "implement"); const r = await run();
    assert.match(r.error.message, /Validation changed/); assert.equal(f.prs.length, 0);
  } },
  validation_resume: { title: "validation-only retry recreates PostgreSQL and validates saved code without Pi, then recovers publication", needsDocker: true, seed: seedIgnore, configure: [configureResumePrepare, configureDatabase], run: async () => {
    f.addIssue(1); f.enqueue(1, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(failed.stage, "validating");
    const calls = f.requests.length;
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 1, "Unchanged prepare inputs reuse pre-agent preparation");
    execFileSync(process.execPath, [resolve("app/src/retry.ts"), failed.taskId, "--validation-only"], { stdio: "pipe" });
    f.faults.pr.add(1); const publishing = await run();
    assert.equal(f.requests.length, calls, "Validation resume must not invoke Pi");
    assert.equal(publishing.stage, "publishing"); assert.ok(publishing.error);
    assert.equal(publishing.inferenceFromRunId, failed.id); assert.equal(publishing.piSessionId, failed.piSessionId);
    assert.equal(publishing.verification.headSha, publishing.publication.commitSha);
    const receipts = readFileSync("database-receipts.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(receipts.map((receipt) => receipt.rows), [1, 0]); assert.notEqual(receipts[0].id, receipts[1].id);
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 2, "Resume retains post-agent preparation exactly once");
    tasks.retryTask(publishing.taskId); const published = await success();
    assert.equal(f.requests.length, calls); assert.equal(f.prs.length, 1);
    assert.equal(published.inferenceFromRunId, publishing.id); assert.deepEqual(published.verification, publishing.verification);
    assert.equal(readFileSync("database-receipts.jsonl", "utf8").trim().split("\n").length, 2);
    for (const attempt of [failed, publishing, published]) assert.equal(execFileSync("docker", ["ps", "-a", "--filter", `name=^/scrat-v2-db-${attempt.id}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim(), "");
  } },
  validation_guards: { title: "validation checkpoints reject changed source, context and incomplete work while normal retry still repairs", seed: seedIgnore, configure: [configureResumePrepare, configureGuardsValidate], run: async () => {
    const changes = [
      (w) => writeFileSync(w.path + "/src/app.ts", "export const changed = true;\n"),
      (w) => writeFileSync(w.path + "/unexpected.ts", "untracked source\n"),
      (w) => git(w.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Changed HEAD"),
      (_w, n) => { f.issues.get(n).body = "Different requirements"; },
      () => changeMain("notes.md", "Base changed\n"),
      (_w, n) => db.update(s.subjects).set({ workspaceId: null }).where(eq(s.subjects.id, "issue-" + n)).run(),
    ];
    for (const [index, change] of changes.entries()) {
      const n = index + 1; f.addIssue(n); f.enqueue(n, "implement"); const failed = await run();
      assert.equal(failed.error.exitCode, 7); const calls = f.requests.length, prepares = readFileSync("prepare.log", "utf8");
      const workspace = f.row(s.workspaces, failed.workspaceId); change(workspace, n);
      tasks.retryTask(failed.taskId, "validation"); const rejected = await run();
      assert.match(rejected.error.message, /checkpoint/i); assert.equal(f.requests.length, calls);
      assert.equal(readFileSync("prepare.log", "utf8"), prepares, "Reject before preparation can alter source");
      assert.equal(f.prs.length, 0);
    }
    f.addIssue(99); f.enqueue(99, "implement"); f.reset(99, "incomplete"); const partial = await run();
    assert.equal(partial.result.outcome, "incomplete");
    assert.throws(() => tasks.retryTask(partial.taskId, "validation"), /complete agent checkpoint/);
    f.addIssue(100); f.enqueue(100, "implement"); const changedInput = await run();
    db.update(s.tasks).set({ input: { requirements: "new" } }).where(eq(s.tasks.id, changedInput.taskId)).run();
    assert.throws(() => tasks.retryTask(changedInput.taskId, "validation"), /unchanged task input/);
    f.addIssue(101); f.enqueue(101, "implement"); const replaced = await run();
    tasks.retryTask(replaced.taskId, "validation");
    f.enqueue(101, "implement", { source: "github_items", kind: "manual", requirements: "replacement" });
    assert.equal(f.row(s.tasks, replaced.taskId).retryMode, "repair");
    f.reset(99, "normal"); unlinkSync("block-validation"); const calls = f.requests.length;
    tasks.retryTask(partial.taskId); const repaired = await success();
    assert.equal(repaired.taskId, partial.taskId);
    assert.ok(f.requests.length > calls); assert.equal(repaired.inferenceFromRunId, null);
    assert.equal(repaired.piSessionId, partial.piSessionId, "Normal retry repairs in the existing session");
    const replacementCalls = f.requests.length; f.reset(101, "normal"); const replacement = await success();
    assert.equal(replacement.taskId, replaced.taskId); assert.ok(f.requests.length > replacementCalls);
    assert.equal(replacement.inferenceFromRunId, null);
  } },
  retry: { title: "publication retries reconcile remote comments and labels without rerunning Pi, a not-ready issue review never removes the selection label, and follow-up issue reviews edit the one assessment comment with the previous assessment in hand while an unchanged one writes nothing", run: async () => {
    for (const [n, fault] of [[1, "label"], [2, "comment"]]) {
      f.addIssue(n, ["human-label"]); f.reset(n, "ready"); f.enqueue(n); f.faults[fault].add(n);
      const first = f.requests.length, failed = await run(); assert.ok(failed.error); const calls = f.requests.length;
      assert.ok(!("previous_assessment" in f.requests[first].context.files), "A first issue review has no previous assessment");
      tasks.retryTask(failed.taskId); const completed = await success();
      assert.equal(completed.retryOfRunId, failed.id); assert.equal(f.requests.length, calls);
      assert.equal(f.written("comment", (w) => w.number === n).length, 1);
      assert.deepEqual(f.issues.get(n).labels.map((label) => label.name).sort(), ["human-label", "scrat"]);
    }
    f.reset(1, "normal"); f.enqueue(1); let written = f.writes.length; const followUp = await success();
    assert.deepEqual(f.issues.get(1).labels.map((label) => label.name).sort(), ["human-label", "scrat"]);
    assert.deepEqual(f.writes.slice(written), [], "A not-ready follow-up never removes the selection label");
    f.addIssue(3); f.enqueue(3); f.onModel = () => { f.issues.get(3).labels = [{ name: "scrat" }]; };
    await success(); f.onModel = undefined;
    assert.deepEqual(f.issues.get(3).labels.map((label) => label.name), ["scrat"], "A review that ends not ready keeps a selection label added while it ran");
    assert.equal(f.comments.get(1).length, 1, "A second review keeps one assessment comment");
    f.reset(1, "revised"); f.enqueue(1); const before = f.requests.length; written = f.writes.length; const revised = await success();
    assert.equal(readFileSync(f.requests[before].context.files.previous_assessment, "utf8"), followUp.result.text);
    assert.deepEqual(f.writes.slice(written).map((w) => w.type), ["comment_update"], "A changed assessment edits the comment in place");
    assert.equal(f.comments.get(1).length, 1); assert.equal(f.comments.get(1)[0].body, `${revised.result.text}\n\n<!-- scrat-review -->`);
    assert.equal(revised.publication.commentId, f.comments.get(1)[0].id);
    f.reset(1, "revised"); f.enqueue(1); written = f.writes.length; const unchanged = await success();
    assert.deepEqual(f.writes.slice(written), [], "An unchanged follow-up makes no GitHub write");
    assert.equal(unchanged.publication.commentId, revised.publication.commentId); assert.equal(unchanged.publication.status, "published");
  } },
  refresh_publication: { title: "stale workflow content is revalidated before a new PR and after a push race on an existing PR", configure: [configureValidation], seed: () => {
    mkdirSync("seed/.github/workflows", { recursive: true }); writeFileSync("seed/.github/workflows/ci.yml", "name: old\n");
    writeFileSync("seed/.gitignore", "/local-recovery.txt\n");
  }, run: async () => {
    const remote = resolve("remote.git"), workflow = ".github/workflows/ci.yml";
    const advance = (name) => { f.onModel = () => { f.onModel = undefined; changeMain(workflow, `name: ${name}\n`); }; };
    const validations = () => readFileSync("validations.log", "utf8").trim().split("\n").length;
    const cleanup = () => execFileSync(process.execPath, [resolve("app/src/cleanup.ts")], { stdio: "pipe" });
    advance("new"); f.addIssue(1, ["scrat"]); f.enqueue(1, "implement"); f.faults.pr.add(1);
    const failed = await run();
    assert.ok(failed.error); assert.equal(f.prs.length, 1);
    const original = all(s.workspaces).find((w) => w.id !== failed.workspaceId);
    assert.ok(original); const originalHead = git(original.path, "rev-parse", "HEAD");
    cleanup();
    assert.ok(existsSync(original.path), "An incomplete publication must keep the original checkout");
    const localNote = resolve(original.path, "local-note.txt");
    writeFileSync(localNote, "unpublished local work\n");
    const ignoredNote = resolve(original.path, "local-recovery.txt");
    writeFileSync(ignoredNote, "unpublished ignored work\n");
    writeFileSync(resolve(original.path, "src/app.ts"), "unpublished stashed work\n");
    git(original.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "stash", "push");
    const stash = git(original.path, "rev-parse", "refs/stash");
    tasks.retryTask(failed.taskId); const first = await success();
    assert.ok(existsSync(localNote), "A successful publication must not remove a modified predecessor");
    unlinkSync(localNote);
    cleanup(); cleanup();
    assert.ok(f.row(s.workspaces, original.id).retainedAt, "The predecessor is explicitly retained after publication");
    assert.equal(readFileSync(ignoredNote, "utf8"), "unpublished ignored work\n");
    assert.equal(git(original.path, "rev-parse", "refs/stash"), stash);
    assert.equal(git(original.repositoryPath, "rev-parse", `refs/scrat/workspaces/${original.id}`), originalHead);
    const head = first.publication.publishedCommitSha;
    assert.equal(git(remote, "show", `${head}:${workflow}`), "name: new");
    assert.equal(git(remote, "show", `${head}:src/app.ts`), "export const value = 11;");
    assert.equal(git(remote, "rev-parse", `${head}^`), git(remote, "rev-parse", "main"));
    assert.equal(first.verification.headSha, head); assert.equal(validations(), 2);
    assert.equal(f.requests.length, 2, "replay and validation do not ask the agent to rewrite the patch");

    const pr = all(s.items).find((item) => item.kind === "pr");
    tasks.enqueueTask({ subjectId: pr.id, action: "address_pr_feedback", reason: "Change existing branch", input: { source: "github_items", kind: "manual" } });
    branchOff("next-main", workflow, "name: newer\n");
    const next = git(remote, "rev-parse", "next-main");
    writeFileSync(resolve(remote, "hooks/pre-receive"), `#!/bin/sh
if test "$(git rev-parse refs/heads/main)" != '${next}'; then
  unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH
  git update-ref refs/heads/main '${next}' || exit 2
  echo 'refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without \`workflows\` permission' >&2
  exit 1
fi
`, { mode: 0o755 });
    const second = await success();
    const updated = second.publication.publishedCommitSha;
    assert.equal(git(remote, "show", `${updated}:${workflow}`), "name: newer");
    assert.equal(git(remote, "show", `${updated}:src/app.ts`), "export const value = 211;");
    git(remote, "merge-base", "--is-ancestor", head, updated);
    assert.equal(second.verification.headSha, updated); assert.equal(validations(), 4);
    assert.equal(f.requests.length, 4); assert.equal(f.prs.length, 1);
    assert.ok(f.row(s.workspaces, first.workspaceId).retainedAt, "A clean predecessor is also retained after publication");
    assert.ok(![...f.tokens.values()].some(({ workflows }) => workflows), "inherited workflow content does not require workflow write access");
  } },
  workflow_push: { title: "an intentional workflow change uses a workflow-capable Git push token", run: async () => {
    writeFileSync("remote.git/hooks/pre-receive", '#!/bin/sh\nprintf "%s\\n" "$GIT_CONFIG_VALUE_0" > ../push-auth\n', { mode: 0o755 });
    f.script = [{ name: "bash", args: { command: "mkdir -p .github/workflows && printf 'name: agent-ci\\n' > .github/workflows/ci.yml" } }];
    const published = await implement(1);
    assert.equal(git(resolve("remote.git"), "show", `${published.publication.publishedCommitSha}:.github/workflows/ci.yml`), "name: agent-ci");
    const credential = Buffer.from(readFileSync("push-auth", "utf8").trim().split(" ").at(-1), "base64").toString("utf8").split(":").at(-1);
    assert.equal(f.tokens.get(credential)?.workflows, "write");
  } },
  competing_implementation: { title: "a GitHub-linked PR defers implementation and closing it unmerged resumes the same task", configure: [configureValidation, (config) => { config.workflows.review_pr.enabled = false; }], run: async () => {
    branchOff("human-fix", "src/app.ts", "export const value = 42;\n");
    f.onModel = () => { f.onModel = undefined; f.addPr(301, "human-fix", "human", { linkedIssues: [1] }); };
    const remote = resolve("remote.git"), before = git(remote, "for-each-ref", "refs/heads");
    f.addIssue(1, ["scrat"]); await route();
    const skipped = await run();
    assert.equal(f.prs.length, 1); assert.equal(git(remote, "for-each-ref", "refs/heads"), before);
    assert.equal(f.row(s.tasks, skipped.taskId).status, "blocked"); assert.ok(!existsSync("validations.log"));
    const attempts = () => all(s.runs).filter((r) => r.taskId === skipped.taskId);
    const calls = f.requests.length;
    const [manual] = tasks.enqueueManualTasks("implement", ["1"]);
    assert.equal(manual.taskId, skipped.taskId);
    f.issues.get(1).labels = [];
    await route();
    assert.equal(f.row(s.tasks, skipped.taskId).status, "blocked", "Removing the label does not cancel an explicit manual request");
    f.prs[0].state = "closed"; await route(); await route();
    assert.equal(f.row(s.tasks, skipped.taskId).status, "queued");
    const resumed = await success();
    assert.equal(resumed.taskId, skipped.taskId); assert.equal(attempts().length, 2);
    assert.equal(resumed.inferenceFromRunId, skipped.id); assert.equal(f.requests.length, calls);
    assert.equal(resumed.publication.pullRequestNumber, 201);

    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement");
    f.addPr(302, "human-fix", "human", { linkedIssues: [2], state: "closed", mergedAt: "2000-01-01T00:00:00Z" });
    f.addPr(303, "human-fix", "human", { linkedIssues: [2], state: "closed" });
    f.addPr(304, "human-fix", "human", { linkedIssues: [2] });
    const blocked = await run();
    assert.equal(f.row(s.tasks, blocked.taskId).status, "blocked");
    assert.equal(blocked.workspaceId, null, "An already linked PR on a later page blocks before allocation");
    assert.equal(f.requests.length, calls);
    const other = f.prs.find((pr) => pr.number === 304);
    other.linkedIssues = []; await route();
    f.onModel = () => { f.onModel = undefined; other.linkedIssues = [2]; };
    const checkpoint = await run();
    assert.equal(checkpoint.taskId, blocked.taskId); assert.ok(checkpoint.agentCheckpoint);
    f.issues.get(2).body = "Requirements changed while blocked";
    other.linkedIssues = []; await route();
    const beforeRepair = f.requests.length;
    const repaired = await success();
    assert.equal(repaired.taskId, blocked.taskId); assert.equal(repaired.workspaceId, checkpoint.workspaceId);
    assert.equal(repaired.inferenceFromRunId, null); assert.ok(f.requests.length > beforeRepair);
    assert.equal(repaired.context.item.body, f.issues.get(2).body);

    f.addIssue(3, ["scrat"]); f.enqueue(3, "implement");
    f.onModel = () => { f.onModel = undefined; f.addPr(305, "human-fix", "human", { linkedIssues: [3], state: "closed", mergedAt: new Date().toISOString() }); };
    const mergeRace = await run();
    assert.equal(f.row(s.tasks, mergeRace.taskId).status, "blocked", "A PR merged during the first attempt still blocks while the issue is open");
    assert.ok(!f.prs.some((pr) => pr.number === 203));
    await route();
    assert.equal(f.row(s.tasks, mergeRace.taskId).status, "blocked");

    const reopened = f.issues.get(3);
    // The issue closes and reopens entirely between two polls.
    reopened.reopened = { id: "reopen-3", createdAt: new Date(Date.now() + 1000).toISOString() };
    await route(); await route();
    const reopenedTasks = all(s.tasks).filter((t) => t.subjectId === "issue-3" && t.action === "implement");
    assert.equal(reopenedTasks.length, 2, "A confirmed reopening selects exactly one new implementation");
    assert.equal(f.row(s.tasks, mergeRace.taskId).status, "cancelled");
    f.reset(3, "normal");
    const published = await success();
    assert.notEqual(published.taskId, mergeRace.taskId); assert.equal(published.inferenceFromRunId, null);
    assert.notEqual(published.workspaceId, mergeRace.workspaceId);
    assert.equal(published.publication.pullRequestNumber, 203);

    f.addIssue(4, ["scrat"]); const queued = f.enqueue(4, "implement");
    f.addPr(306, "human-fix", "human", { linkedIssues: [4] }); await route();
    assert.equal(f.row(s.tasks, queued.id).status, "blocked");
    f.issues.get(4).state = "closed"; await route();
    assert.equal(f.row(s.tasks, queued.id).status, "cancelled", "An observed close ends the blocked task");

    const graphqlCalls = () => f.calls.filter((call) => call.path === "/graphql").length;
    const beforeIdleSync = graphqlCalls();
    await route();
    assert.equal(graphqlCalls(), beforeIdleSync, "Steady-state sync skips GraphQL for unchanged settled issues");

    // A settled issue reopened during a rate-limit deferral must still be checked on the next sync.
    const savedRemaining = f.rate.remaining;
    f.rate.remaining = 0;
    reopened.updated_at = "2026-10-19T00:10:00Z";
    reopened.reopened = { id: "reopen-3-again", createdAt: new Date(Date.now() + 2000).toISOString() };
    await route();
    assert.equal(all(s.tasks).filter((t) => t.subjectId === "issue-3" && t.action === "implement").length, 2);
    f.rate.remaining = savedRemaining; f.rate.reset++;
    await route();
    assert.equal(all(s.tasks).filter((t) => t.subjectId === "issue-3" && t.action === "implement").length, 3,
      "A deferred settled-issue update is retried after rate limits recover");

    f.addIssue(5, ["scrat"]);
    f.addPr(307, "human-fix", "human", { linkedIssues: [5], state: "closed", mergedAt: "2026-10-19T00:05:00Z" });
    await route();
    const lagBlocked = all(s.tasks).find((t) => t.subjectId === "issue-5" && t.action === "implement");
    assert.equal(lagBlocked?.status, "blocked", "A PR merged in the current opening blocks first selection through closure lag");
  } },
  ambiguous_pr: { title: "partial publication resumes safely after a lost PR response or a competing PR after push", configure: [configureValidation, (config) => { config.workflows.review_pr.enabled = false; }], seed: () => {
    mkdirSync("seed/.github/workflows", { recursive: true }); writeFileSync("seed/.github/workflows/ci.yml", "name: old\n");
  }, run: async () => {
    const validations = () => readFileSync("validations.log", "utf8").trim().split("\n").length;
    f.addIssue(1); f.enqueue(1, "implement"); f.faults.pr.add(1);
    const failed = await run(); assert.ok(failed.error); assert.equal(f.prs.length, 1); const calls = f.requests.length;
    assert.equal(validations(), 1);
    const saved = f.row(s.runs, failed.id);
    assert.equal(saved.stage, "publishing"); assert.equal(saved.publication.commitSha, saved.headSha); assert.equal(saved.verification.headSha, saved.headSha);
    tasks.retryTask(failed.taskId); const completed = await success();
    assert.equal(completed.publication.pullRequestNumber, 201); assert.equal(f.prs.length, 1); assert.equal(f.requests.length, calls);
    assert.equal(validations(), 1); assert.equal(completed.inferenceFromRunId, failed.id);

    const remote = resolve("remote.git"), workflow = ".github/workflows/ci.yml";
    branchOff("human-fix", "notes.md", "Competing work\n");
    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement");
    const fetch = globalThis.fetch;
    let linked;
    globalThis.fetch = (input, init) => {
      if (!linked && String(input) === "https://api.github.com/graphql") {
        const body = JSON.parse(init.body), { number } = body.variables ?? body;
        const workspace = f.row(s.workspaces, f.row(s.subjects, "issue-2").workspaceId);
        if (number === 2 && workspace && git(remote, "for-each-ref", `refs/heads/${workspace.branch}`)) {
          f.addPr(301, "human-fix", "human", { linkedIssues: [2] });
          linked = f.prs.at(-1);
        }
      }
      return fetch(input, init);
    };
    let deferred;
    try { deferred = await run(); }
    finally { globalThis.fetch = fetch; }
    const pushed = deferred.publication.publishedCommitSha;
    assert.ok(pushed && linked); assert.equal(f.row(s.tasks, deferred.taskId).status, "blocked");
    assert.ok(!f.prs.some((pr) => pr.number === 202));
    linked.state = "closed"; changeMain(workflow, "name: new\n"); await route();
    f.reset(2, "normal");
    f.script = [{ name: "write", args: { path: "src/app.ts", content: "export const value = 123;\n" } }];
    const repaired = await success(), published = repaired.publication.publishedCommitSha;
    assert.equal(repaired.taskId, deferred.taskId); assert.equal(repaired.publication.pullRequestNumber, 202);
    git(remote, "merge-base", "--is-ancestor", pushed, published);
    assert.equal(git(remote, "show", `${published}:${workflow}`), "name: new");
    assert.equal(git(remote, "show", `${published}:src/app.ts`), "export const value = 123;");

    // The Git write succeeds, but the SQLite transaction recording it does not.
    const losePushReceipt = async () => {
      db.$client.exec(`CREATE TRIGGER reject_push_receipt BEFORE UPDATE OF publication ON runs
        WHEN json_extract(NEW.publication, '$.publishedCommitSha') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'fixture lost push receipt'); END`);
      try { return await run(); }
      finally { db.$client.exec("DROP TRIGGER reject_push_receipt"); }
    };
    f.script = undefined;
    f.addIssue(3, ["scrat"]); await route();
    const retryable = await losePushReceipt();
    const priorBranch = f.row(s.workspaces, retryable.workspaceId).branch;
    const priorPush = git(remote, "rev-parse", priorBranch);
    assert.ok(retryable.error); assert.equal(retryable.publication.publishedCommitSha, undefined);
    assert.equal(priorPush, retryable.verification.headSha);
    tasks.retryTask(retryable.taskId);
    f.addPr(302, "human-fix", "human", { linkedIssues: [3] }); await route();
    assert.equal(f.row(s.tasks, retryable.taskId).status, "blocked");
    const beforeRetry = f.requests.length;
    f.issues.get(3).body = "Requirements changed while sync blocked the retry";
    changeMain(workflow, "name: newer\n");
    f.prs.at(-1).state = "closed"; await route(); await route();
    f.reset(3, "normal");
    f.script = [{ name: "write", args: { path: "src/app.ts", content: "export const value = 321;\n" } }];
    const retried = await success();
    assert.equal(retried.taskId, retryable.taskId); assert.equal(retried.publication.pullRequestNumber, 203);
    assert.ok(f.requests.length > beforeRetry);
    git(remote, "merge-base", "--is-ancestor", priorPush, retried.publication.publishedCommitSha);
    assert.equal(git(remote, "show", `${retried.publication.publishedCommitSha}:${workflow}`), "name: newer");
    assert.equal(git(remote, "show", `${retried.publication.publishedCommitSha}:src/app.ts`), "export const value = 321;");

    f.script = undefined;
    f.addIssue(4, ["scrat"]); f.enqueue(4, "implement");
    const lostPush = await losePushReceipt();
    assert.ok(lostPush.error); assert.equal(lostPush.publication.publishedCommitSha, undefined);
    const workspace = f.row(s.workspaces, lostPush.workspaceId), branch = `refs/heads/${workspace.branch}`;
    const written = git(remote, "rev-parse", branch);
    assert.equal(written, lostPush.verification.headSha);
    const unexpected = pushFile(workspace.branch, "notes.md", "Unvalidated update after Scrat pushed\n");
    const beforeRecovery = f.requests.length;
    tasks.retryTask(lostPush.taskId); const rejected = await run();
    assert.match(rejected.error.message, /Remote branch changed before/);
    assert.equal(git(remote, "rev-parse", branch), unexpected);
    git(remote, "update-ref", branch, written, unexpected);
    tasks.retryTask(lostPush.taskId); const recovered = await success();
    assert.equal(recovered.publication.publishedCommitSha, written);
    assert.equal(recovered.publication.pullRequestNumber, 204); assert.equal(f.requests.length, beforeRecovery);

    f.addIssue(5, ["scrat"]); f.enqueue(5, "implement");
    const githubFetch = globalThis.fetch;
    let changedHead;
    globalThis.fetch = (input, init) => {
      if (!changedHead && String(input).endsWith("/pulls") && init?.method === "POST") {
        changedHead = pushFile(JSON.parse(init.body).head, "notes.md", "Unvalidated update during PR creation\n");
      }
      return githubFetch(input, init);
    };
    let mismatched;
    try { mismatched = await run(); }
    finally { globalThis.fetch = githubFetch; }
    assert.equal(f.prs.find((pr) => pr.number === 205).head.sha, changedHead);
    assert.match(mismatched.error?.message, /PR head differs from the validated commit/);
    assert.equal(mismatched.publication.pullRequestNumber, undefined);
    tasks.retryTask(mismatched.taskId);
    assert.match((await run()).error?.message, /PR head differs from the validated commit/);
  } },
  freshness: { title: "requirements changed during inference cannot receive an approval label", run: async () => {
    f.addIssue(1); await route(); f.reset(1, "ready");
    f.onModel = () => { f.issues.get(1).body = "New requirements"; };
    const r = await run(); assert.match(r.error.message, /context changed/); assert.equal(f.writes.length, 0);
    f.onModel = undefined; await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"));
    f.addIssue(2); f.enqueue(2, "implement"); f.onModel = () => { f.issues.get(2).body = "Changed implementation requirements"; };
    const stale = await run(); assert.match(stale.error.message, /context changed/); assert.equal(f.prs.length, 0);
  } },
  freshness_policy: { title: "one freshness policy distinguishes exact, context, irrelevant and relevant base changes", run: async () => {
    const { freshness, savedEvaluation } = await f.app("freshness.ts");
    const { fetchRepository } = await f.app("git.ts");
    const fetchMain = () => fetchRepository(f.config.github.repositoryPath, "https://github.com/fixture/project.git", "main");
    f.addIssue(1); f.reset(1, "grep"); await route(); const saved = savedEvaluation(await success());
    assert.ok(saved.mainSha && saved.paths.includes("src/app.ts"));
    const now = { revision: saved.revision, baseBranch: saved.baseBranch, mainSha: saved.mainSha };
    for (const mode of ["exact", "relevant-paths"]) assert.deepEqual(await freshness(saved, now, mode), { kind: "current", baseMoved: false });
    for (const mode of ["exact", "relevant-paths"]) {
      assert.deepEqual(await freshness(saved, { ...now, revision: "changed" }, mode), { kind: "stale", reason: "context", changedPaths: [] });
      assert.deepEqual(await freshness(saved, { ...now, baseBranch: "release" }, mode), { kind: "stale", reason: "context", changedPaths: [] });
    }
    let fetched = false;
    const lazy = async () => { fetched = true; return saved.mainSha; };
    assert.equal((await freshness(saved, { ...now, revision: "changed", mainSha: lazy }, "relevant-paths")).kind, "stale"); assert.ok(!fetched);
    assert.equal((await freshness(saved, { ...now, mainSha: lazy }, "relevant-paths")).kind, "current"); assert.ok(fetched);
    assert.equal((await freshness(saved, { revision: saved.revision, baseBranch: saved.baseBranch }, "relevant-paths")).kind, "current");
    const unknown = { ...saved, mainSha: null };
    assert.equal((await freshness(unknown, now, "relevant-paths")).kind, "stale");
    assert.equal((await freshness(unknown, now, "relevant-paths", true)).kind, "current");
    changeMain("notes.md", "new docs\n"); const docsSha = await fetchMain(); assert.notEqual(docsSha, saved.mainSha);
    assert.deepEqual(await freshness(saved, { ...now, mainSha: docsSha }, "relevant-paths"), { kind: "current", baseMoved: true });
    assert.deepEqual(await freshness(saved, { ...now, mainSha: docsSha }, "exact"), { kind: "stale", reason: "base", changedPaths: [] });
    changeMain("src/app.ts", "export const changed = true;\n"); const codeSha = await fetchMain();
    const relevant = await freshness(saved, { ...now, mainSha: codeSha }, "relevant-paths");
    assert.equal(relevant.kind, "stale"); assert.equal(relevant.reason, "base"); assert.ok(relevant.changedPaths.includes("src/app.ts"));
  } },
  relevance: { title: "root searches, unrelated development dependencies and ignored generated paths do not trigger re-review", seed: seedLockfile, configure: [configureLockfile, (config) => { config.relevance.ignoredPaths = ["^assets/\\.vite/"]; }], run: async () => {
    branchOff("feature", "src/feature.ts", "export const feature = 1;\n"); f.addPr(1, "feature", "human"); f.reset(1, "grep"); await route(); const r = await success();
    assert.ok(r.result.paths.includes("src/app.ts")); assert.ok(!r.result.paths.includes("."));
    assert.ok(r.result.paths.includes("assets/.vite/manifest.json"), "The review read the generated manifest");
    changeMain("notes.md", "new docs\n"); await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("assets/.vite/manifest.json", '{"app":"app-2.js"}\n'); await route();
    assert.ok(!all(s.tasks).some((t) => t.status === "queued"), "A push touching only ignored paths queues no review");
    changeMain("package.json", JSON.stringify({ dependencies: { otherRuntime: "1.0.0" }, optionalDependencies: { optPkg: "1.0.0" }, devDependencies: { wrangler: "1.0.0", unrelated: "2.0.0" } }));
    changeMain("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@2.0.0:\n    resolution: {integrity: new}\n");
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"), "Unrelated dependencies/devDependencies/optionalDependencies must not trigger review");
    changeMain("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: changed}\n  unrelated@2.0.0:\n    resolution: {integrity: newer}\n");
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"), "A changed inspected package beside an unrelated bump must trigger review");
    f.reset(1, "grep"); await success();
    changeMain("package.json", JSON.stringify({ dependencies: { otherRuntime: "2.0.0" }, optionalDependencies: { optPkg: "2.0.0" }, devDependencies: { wrangler: "2.0.0", unrelated: "2.0.0" } }));
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"), "Inspected dependency changes must trigger review");
    f.script = [
      { name: "git", args: { operation: "log", path: "src" } },
      { name: "git", args: { operation: "log", path: "." } },
      { name: "git", args: { operation: "show", revision: "head", path: "." } },
      { name: "git", args: { operation: "diff_stat", from: "previousMain", to: "main" } },
      { name: "git", args: { operation: "diff_stat", from: "base", to: "main" } },
      { name: "git", args: { operation: "diff_stat", from: "main", to: "head" } },
    ];
    const scoped = await success(); f.script = undefined;
    assert.ok(!scoped.result.paths.includes("src") && !scoped.result.paths.includes(".") && !scoped.result.paths.includes("notes.md"), "directory log, dot log/show and base-drift diffs do not pollute scope");
    db.update(s.runs).set({ result: { ...scoped.result, paths: ["src", ...scoped.result.paths] } }).where(eq(s.runs.id, scoped.id)).run();
    changeMain("src/unrelated.ts", "export const unrelated = 1;\n");
    await route();
    assert.ok(!all(s.tasks).some((t) => t.status === "queued"), "legacy directory entries in persisted scope do not trigger unrelated re-reviews");
    // PR-only directories (present in head, absent from base) and previousHead..head merge/rebase deltas do not pollute scope.
    git(resolve("seed"), "checkout", "feature");
    git(resolve("seed"), "merge", "--no-edit", "main");
    mkdirSync(resolve("seed/pronly"), { recursive: true });
    writeFileSync(resolve("seed/pronly/extra.ts"), "export const extra = 1;\n");
    git(resolve("seed"), "add", "."); commit(resolve("seed"), "Merge main and add pronly");
    git(resolve("seed"), "push", resolve("remote.git"), "feature");
    f.prs[0].head.sha = git(resolve("remote.git"), "rev-parse", "feature");
    git(resolve("seed"), "checkout", "main");
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"));
    f.script = [
      { name: "git", args: { operation: "log", path: "pronly" } },
      { name: "git", args: { operation: "diff_stat", from: "previousHead", to: "head" } },
      { name: "git", args: { operation: "diff", from: "previousHead", to: "head", path: "pronly" } },
      { name: "git", args: { operation: "diff", from: "previousHead", to: "head", path: "src/nonexistent.ts" } },
      { name: "git", args: { operation: "diff", from: "previousHead", to: "head", path: "src/app.ts" } },
      { name: "git", args: { operation: "diff", from: "previousHead", to: "head", path: "notes.md" } },
      { name: "git", args: { operation: "diff", from: "base", to: "head", path: "src/unrelated.ts" } },
    ];
    const prDirScoped = await success(); f.script = undefined;
    assert.ok(!prDirScoped.result.paths.includes("pronly"), "PR-only directory paths are stripped from git scope");
    assert.ok(!prDirScoped.result.paths.includes("src/nonexistent.ts") && !prDirScoped.result.paths.includes("src/app.ts"), "nonexistent or unchanged targeted previousHead..head paths are not added to scope");
    assert.ok(!prDirScoped.result.paths.includes("src/unrelated.ts"), "previousHead..head and unchanged base..head diffs do not pull unrelated base files into scope");
    assert.ok(prDirScoped.result.paths.includes("notes.md"), "targeted previousHead..head diff on a file that actually changed records that file");
    // Legacy "." and deleted-on-main directories persisted on a previous review heal on re-review instead of sticking forever.
    mkdirSync(resolve("seed/obsolete"), { recursive: true });
    writeFileSync(resolve("seed/obsolete/old.ts"), "export const old = 1;\n");
    git(resolve("seed"), "add", "."); commit(resolve("seed"), "Add obsolete dir on main");
    git(resolve("seed"), "push", resolve("remote.git"), "main");
    const mainWithObsolete = git(resolve("remote.git"), "rev-parse", "main");
    db.update(s.runs).set({ mainSha: mainWithObsolete, result: { ...prDirScoped.result, paths: [".", "obsolete", ...prDirScoped.result.paths] } }).where(eq(s.runs.id, prDirScoped.id)).run();
    git(resolve("seed"), "rm", "-rf", "obsolete");
    writeFileSync(resolve("seed/notes.md"), "heal dot and deleted dir\n");
    git(resolve("seed"), "add", "."); commit(resolve("seed"), "Remove obsolete dir and touch notes");
    git(resolve("seed"), "push", resolve("remote.git"), "main");
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"));
    f.reset(1, "grep");
    const healed = await success();
    assert.ok(!healed.result.paths.includes(".") && !healed.result.paths.includes("obsolete"), "retainedScope strips legacy '.' and directories deleted on main");
    // Issue review (no baseSha) also strips directory and '.' paths from git tool calls, and skips stale queued re-reviews pre-inference.
    f.addIssue(2); await route();
    f.script = [
      { name: "read", args: { path: "src/app.ts" } },
      { name: "git", args: { operation: "log", path: "src" } },
      { name: "git", args: { operation: "log", path: "." } },
    ];
    const issueReviewed = await success(); f.script = undefined;
    assert.ok(issueReviewed.result.paths.includes("src/app.ts"));
    assert.ok(!issueReviewed.result.paths.includes("src") && !issueReviewed.result.paths.includes("."), "review_issue strips directory and '.' paths from git scope");
    const requestsBeforeIssueSkip = f.requests.length;
    tasks.enqueueTask({
      subjectId: f.row(s.tasks, issueReviewed.taskId).subjectId, action: "review_issue", priority: 200, reason: "Queued before earlier issue review finished",
      input: { source: "github_items", kind: "item_changed", triggerKey: "stale-issue-queued", revision: "stale", mainSha: issueReviewed.mainSha, changedPaths: [] },
    });
    const skippedIssue = await run();
    assert.equal(f.requests.length, requestsBeforeIssueSkip, "review_issue pre-inference freshness skip makes zero model requests");
    assert.equal(skippedIssue.error?.code, "RUN_SUPERSEDED");
  } },
  lockfile_impact: { title: "the pure lockfile differ separates inspected-package, alias, importer and unknown-shape changes from unrelated ones without a repository", run: async () => {
    const { lockfileChanged, affectsPaths } = await f.app("lockfile-impact.ts");
    const base = "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@1.0.0:\n    resolution: {integrity: old}\n"
      + "  string-width-cjs@npm:string-width@4.2.2:\n    resolution: {integrity: alias}\nsnapshots:\n  wrangler@1.0.0:\n    dependencies: {nested: 1.0.0}\n"
      + "importers:\n  .:\n    devDependencies:\n      wrangler: {specifier: 1.0.0, version: 1.0.0}\n      unrelated: {specifier: 1.0.0, version: 1.0.0}\n";
    const inspected = new Set(["wrangler", "string-width-cjs"]);
    const changed = (update) => lockfileChanged(base, update(base), inspected);
    assert.equal(lockfileChanged(base, base, inspected), false);
    assert.equal(changed((text) => text.replaceAll("unrelated@1.0.0", "unrelated@2.0.0").replaceAll("unrelated: {specifier: 1.0.0, version: 1.0.0}", "unrelated: {specifier: 2.0.0, version: 2.0.0}")), false);
    assert.equal(changed((text) => text.replace("unrelated@1.0.0:\n    resolution: {integrity: old}", "unrelated@1.0.0:\n    resolution: {integrity: new}")), false);
    assert.equal(changed((text) => text.replace("integrity: old", "integrity: new")), true);
    assert.equal(changed((text) => text.replace("integrity: old", "integrity: new").replaceAll("unrelated@1.0.0", "unrelated@2.0.0")), true);
    assert.equal(changed((text) => text.replace("npm:string-width@4.2.2", "npm:string-width@4.2.3")), true);
    assert.equal(changed((text) => text.replace("nested: 1.0.0", "nested: 2.0.0")), true);
    assert.equal(changed((text) => text.replace("npm:string-width@4.2.2", "npm:string-width@4.2.3").replaceAll("unrelated@1.0.0", "unrelated@2.0.0")), true);
    assert.equal(changed((text) => text.replace("wrangler: {specifier: 1.0.0, version: 1.0.0}", "wrangler: {specifier: 2.0.0, version: 2.0.0}")), true);
    assert.equal(changed((text) => text.replace("unrelated: {specifier: 1.0.0, version: 1.0.0}", "unrelated: {specifier: 1.0.0, version: npm:wrangler@2.0.0}")), true);
    assert.equal(changed((text) => text.replace("unrelated: {specifier: 1.0.0, version: 1.0.0}", "unrelated: {specifier: workspace:*, version: link:../unrelated}")), true);
    assert.equal(changed((text) => text.replace("importers:\n", "importers:\n  packages/new: {}\n")), true);
    assert.equal(changed((text) => text + "unknownSetting: changed\n"), true);
    assert.equal(changed((text) => text.replace("importers:\n  .:\n", "importers:\n  .:\n    injectedSetting: true\n")), true);
    assert.equal(changed((text) => text.replace("unrelated: {specifier: 1.0.0, version: 1.0.0}", "unrelated: 3.0.0")), true);
    assert.throws(() => lockfileChanged(base, "- not\n- a record\n", inspected), /Unrecognized lockfile/);
    assert.equal(affectsPaths(["src/app.ts"], ["src"]), true); assert.equal(affectsPaths(["srcs/app.ts"], ["src/"]), false);
    assert.equal(affectsPaths(["a.ts"], ["a.ts"]), true); assert.equal(affectsPaths(["b.ts"], ["a.ts"]), false);
  } },
  review_scope: { title: "Pi path aliases and supplied PR diff files participate in freshness and re-review", run: async () => {
    f.addIssue(1); f.reset(1, "at"); await route();
    const reviewed = await success(); assert.ok(reviewed.result.paths.includes("src/app.ts"));
    changeMain("src/app.ts", "export const value = 9;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 1;\n");
    await implement(2); await route(); f.reset(202, "helper");
    let changed = false;
    f.onModel = (context) => {
      if (!changed && context.item.number === 202) { changed = true; changeMain("src/app.ts", "export const value = 99;\n"); }
    };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
    assert.ok(stale.result.paths.includes("src/app.ts")); assert.ok(stale.result.paths.includes("src/helper.ts"));
    assert.equal(f.written("comment", (w) => w.number === 202).length, 0);
  } },
  unicode_scope: { title: "Pi filename normalization cannot hide relevant base changes", seed: seedUnicodeScope, run: async () => {
    f.addIssue(1); f.reset(1, "nbsp"); await route(); await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const special = 1;"))));
    changeMain("src/a b.ts", "export const special = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
    f.reset(1, "nbsp");
    let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/a b.ts", "export const special = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } },
  unicode_nfd: { title: "current and persisted Unicode read scopes map to Git filenames across filesystem spellings", seed: seedUnicodeNfd, run: async () => {
    f.addIssue(1); await route(); const reviewed = await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const unicode = 1;"))));
    assert.ok(reviewed.result.paths.includes("src/caf\u00e9.ts"));
    db.update(s.runs).set({ result: { ...reviewed.result, paths: ["src/cafe\u0301.ts"] } }).where(eq(s.runs.id, reviewed.id)).run();
    changeMain("src/caf\u00e9.ts", "export const unicode = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal"); let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/caf\u00e9.ts", "export const unicode = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } },
  unknown_scope: { title: "an unknown read scope (.) remains conservative even alongside known paths", run: async () => {
    f.addIssue(1); await route(); let reviewed = await success();
    for (const paths of [[".", "src/app.ts"], ["."], ["src"]]) {
      db.update(s.runs).set({ result: { ...reviewed.result, paths } }).where(eq(s.runs.id, reviewed.id)).run();
      changeMain(paths[0] === "src" ? "src/helper.ts" : "notes.md", JSON.stringify(paths)); await route();
      assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
      reviewed = await success();
    }
  } },
  stale_branch: { title: "a human PR whose branch is behind and cannot be prepared is reviewed on a local merge without pushing, or says once in its assessment comment that the merge conflicts and is not retried until its head or base changes or a review is requested by hand", configure: [configureStaleBranch], run: () => staleBranch("human") },
  stale_branch_scrat: { title: "behind Scrat PRs are merged in code, fall back to the agent when validation fails, self-heal feedback tasks and reach the agent when conflicting", configure: [configureStaleBranch], run: () => staleBranch("scrat") },
  validation_feedback: { title: "a failed validation is sent back into the same Pi session, fixed there and published as one commit, including after a restart resumed it at validation", configure: [configureValidation], run: () => validationFeedback("fix") },
  validation_feedback_cap: { title: "validation feedback stops after two rounds and never applies to signal-killed commands, and sync labels each issue whose implementation failed for good until it is retried", configure: [configureValidation], run: () => validationFeedback("cap") },
  measured_checks: { title: "a chatty passing validation command stores a bounded tail and keeps its full output on disk", configure: [configureChatty], run: async () => {
    const r = await implement(1);
    const [check] = r.verification.commands;
    assert.equal(check.status, "passed"); assert.equal(check.name, `${process.execPath} ${resolve("chatty.mjs")}`);
    assert.ok(Buffer.byteLength(check.tail) <= 2000); assert.match(check.tail, /final line \[redacted\]/);
    assert.ok(!JSON.stringify(r.verification).includes("ghs_fixture_sensitive"));
    assert.equal(check.evidence.length, 1); assert.match(check.evidence[0], new RegExp(`^${resolve("data/checks", r.id)}/validate-0-\\d+\\.log$`)); assert.ok(!check.evidence[0].startsWith(resolve("data/runs", r.id)));
    assert.ok(statSync(check.evidence[0]).size > 20 * 1024 * 1024);
    const { runHistory } = await f.app("run-history.ts");
    const [entry] = runHistory(f.row(s.tasks, r.taskId).subjectId, ["implement"]);
    assert.equal(entry.run.id, r.id); assert.ok(!("verification" in entry.run)); assert.deepEqual(Object.keys(entry.run.context).sort(), ["baseBranch", "commentRevisions", "revision"]);
  } },
  command_timeout: { title: "a validation command that outlives harness.commandTimeoutSeconds is killed, fails the run as infrastructure without re-prompting the agent and accepts validation-only retry", configure: [configureCommandTimeout], run: async () => {
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
    const started = Date.now(), failed = await run();
    assert.ok(Date.now() - started < 20_000);
    assert.ok(failed.error); assert.equal(failed.error.exitCode, undefined); assert.equal(failed.stage, "validating");
    assert.match(failed.error.message, /timed out after 1 seconds/);
    assert.equal(f.requests.length, 2, "agent turn only");
    assert.equal(f.prs.length, 0);
    tasks.retryTask(failed.taskId, "validation");
    assert.equal(f.row(s.tasks, failed.taskId).status, "queued");
  } },
  deploy_stop_boundary: { title: "a stop signal ends a run at the next stage boundary, requeues its task, and the next worker resumes validation or publication without redoing earlier stages", configure: [configureValidation], run: async () => {
    const validations = () => existsSync("validations.log") ? readFileSync("validations.log", "utf8").trim().split("\n").length : 0;
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
    const stop = new AbortController(); f.onModel = () => stop.abort();
    const cut = await f.runNextTask(stop.signal); f.onModel = undefined;
    assert.equal(cut.error.code, "RUN_INTERRUPTED"); assert.equal(cut.stage, "validating");
    assert.equal(f.row(s.tasks, cut.taskId).status, "queued"); assert.equal(f.row(s.tasks, cut.taskId).retryMode, "validation");
    const agentRequests = f.requests.length; assert.ok(agentRequests > 0); assert.equal(validations(), 0); assert.equal(f.prs.length, 0);
    const resumed = await success();
    assert.equal(resumed.retryOfRunId, cut.id); assert.equal(resumed.inferenceFromRunId, cut.id);
    assert.equal(f.requests.length, agentRequests, "the agent is not re-prompted"); assert.equal(validations(), 1);
    assert.equal(resumed.publication.pullRequestNumber, 201); assert.equal(f.prs.length, 1);
    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement");
    const requests = f.requests.length, before = validations();
    const publishing = new AbortController();
    writeFileSync("slow", "1");
    const watch = setInterval(() => { if (validations() > before) publishing.abort(); }, 10);
    const atPublication = await f.runNextTask(publishing.signal); clearInterval(watch); unlinkSync("slow");
    assert.equal(atPublication.error.code, "RUN_INTERRUPTED"); assert.equal(atPublication.stage, "publishing");
    assert.equal(f.row(s.tasks, atPublication.taskId).status, "queued"); assert.equal(f.row(s.tasks, atPublication.taskId).retryMode, "repair");
    assert.equal(f.requests.length, requests + agentRequests); assert.equal(validations(), before + 1); assert.equal(f.prs.length, 1);
    const published = await success();
    assert.equal(published.retryOfRunId, atPublication.id); assert.equal(published.inferenceFromRunId, atPublication.id);
    assert.equal(f.requests.length, requests + agentRequests); assert.equal(validations(), before + 1); assert.equal(f.prs.length, 2);
    f.addIssue(3, ["scrat"]); f.enqueue(3, "implement");
    const used = f.requests.length, early = await f.runNextTask(AbortSignal.abort());
    assert.equal(early.error.code, "RUN_INTERRUPTED"); assert.equal(early.stage, "preparing");
    assert.equal(f.row(s.tasks, early.taskId).status, "queued"); assert.equal(f.row(s.tasks, early.taskId).retryMode, "repair");
    assert.equal(f.requests.length, used);
    const fresh = await success(); assert.equal(fresh.retryOfRunId, null); assert.equal(f.prs.length, 3);
    const { config } = await f.app("config.ts"), { withValidationSlot } = await f.app("commands.ts");
    config.harness.maxConcurrentValidations = 1;
    let release; const holder = withValidationSlot(() => new Promise((done) => { release = done; }));
    f.addIssue(4, ["scrat"]); f.enqueue(4, "implement");
    const waiting = new AbortController(), counted = validations();
    const hold = setInterval(() => { if (all(s.runs).some((r) => r.stage === "validating" && !r.finishedAt)) waiting.abort(); }, 10);
    let slotted; try { slotted = await f.runNextTask(waiting.signal); } finally { clearInterval(hold); release(); await holder; }
    assert.equal(slotted.error.code, "RUN_INTERRUPTED"); assert.equal(slotted.stage, "validating"); assert.equal(validations(), counted);
    assert.equal(f.row(s.tasks, slotted.taskId).status, "queued"); assert.equal(f.row(s.tasks, slotted.taskId).retryMode, "validation");
  } },
  deploy_stop_agent_timeout: { title: "a stop signal during an agent turn aborts the session after harness.drainTimeoutSeconds, publishes nothing and requeues the task", configure: [(config) => { config.harness.drainTimeoutSeconds = 1; }], run: async () => {
    f.addIssue(1, ["scrat"]); f.reset(1, "stall"); f.enqueue(1, "implement");
    const stop = new AbortController(); f.onModel = () => stop.abort();
    const started = Date.now(), cut = await f.runNextTask(stop.signal);
    assert.ok(Date.now() - started < 20_000);
    assert.equal(cut.error.code, "RUN_INTERRUPTED"); assert.match(cut.error.message, /1 seconds after the worker was told to stop/);
    assert.equal(cut.stage, "agent"); assert.equal(f.row(s.tasks, cut.taskId).status, "queued"); assert.equal(f.row(s.tasks, cut.taskId).retryMode, "repair");
    assert.equal(f.requests.length, 1); assert.equal(f.prs.length, 0);
    f.onModel = undefined; f.modes.delete(1);
    const restarted = await run();
    assert.equal(restarted.retryOfRunId, null); assert.equal(f.requests.length, 2);
  } },
  agent_timeout: { title: "an agent turn that outlives harness.agentTimeoutSeconds is aborted and fails the run with AGENT_TIMEOUT", configure: [(config) => { config.harness.agentTimeoutSeconds = 1; }], run: async () => {
    f.addIssue(1, ["scrat"]); f.reset(1, "stall"); f.enqueue(1, "implement");
    const started = Date.now(), failed = await run();
    assert.ok(Date.now() - started < 20_000);
    assert.equal(failed.error.code, "AGENT_TIMEOUT"); assert.match(failed.error.message, /exceeded 1 seconds/);
    assert.equal(f.requests.length, 1); assert.equal(f.prs.length, 0);
  } },
  bash_guard: { title: "heavy commands are refused in the agent's bash tool and wait for a validation slot", run: async () => {
    const { heavyCommand, backgroundsWork } = await f.app("commands.ts");
    for (const command of ["pnpm verify &", "nohup pnpm lint", "a & b", "setsid pnpm verify", "pnpm lint; disown", "pnpm verify &   "]) assert.ok(backgroundsWork(command), command);
    for (const command of ["a && b", "x 2>&1", "x &> f", "y 3>&1", "a |& b", "pnpm lint > nohup.out", "echo a \\& b", 'echo "a & b"', "cat setsid.txt"]) assert.ok(!backgroundsWork(command), command);
    const patterns = JSON.parse(readFileSync(new URL("../scrat.config.json", import.meta.url), "utf8")).workspace.heavyCommands.map((pattern) => new RegExp(pattern));
    for (const command of ["pnpm lint && pnpm type-check", "nohup pnpm verify > l 2>&1 &", "env X=1 tsc -b", "cd x && pnpm verify", "npx eslint .", "pnpm test:e2e:smoke", "FOO=1 timeout 60 pnpm run build", "echo hi; pnpm exec playwright test", "x=$(pnpm knip)", "pnpm  lint", "pnpm -r lint", "pnpm -w run verify", "npx playwright show-report", "pnpm exec playwright codegen"]) {
      assert.ok(heavyCommand(command, patterns), command);
    }
    for (const command of ["pnpm test", "pnpm check src/a.ts", "pnpm exec vitest run a.test.ts", "pnpm build:cli", "pnpm test:db:ci", 'git commit -m "pnpm lint"', "grep eslint f", "eslint src/a.ts", "pnpm test:cli", 'git commit -m "a; pnpm lint ok"', "git commit -m \"fix\n\npnpm verify was failing\"", 'grep -E "foo|tsc b" f', "sh -c 'pnpm verify'", "pnpm exec playwright --version"]) {
      assert.equal(heavyCommand(command, patterns), undefined, command);
    }
    assert.equal(heavyCommand("cd x && pnpm verify", patterns), "pnpm verify");
    const toolResults = () => JSON.stringify(f.requests.findLast((entry) => entry.request.messages.some((message) => message.role === "tool")).request.messages.filter((message) => message.role === "tool"));
    const attempt = async (number, mode) => { f.addIssue(number, ["scrat"]); f.reset(number, mode); f.enqueue(number, "implement"); return run(); };
    const { withValidationSlot } = await f.app("commands.ts"), { config: live } = await f.app("config.ts");
    const heavyFiles = () => all(s.workspaces).filter((w) => existsSync(resolve(w.path, ".scrat/heavy-fg")));
    let nohup, background, foreground, nohupSeen, backgroundSeen, heldFiles, heldRequests, release;
    try {
      nohup = await attempt(1, "heavy"); nohupSeen = toolResults(); background = await attempt(2, "heavy-bg"); backgroundSeen = toolResults();
      live.harness.maxConcurrentValidations = 1;
      const holder = withValidationSlot(() => new Promise((done) => { release = done; }));
      const asked = f.requests.length;
      const pending = attempt(3, "heavy-fg");
      for (let n = 0; n < 600 && f.requests.length === asked; n++) await new Promise((done) => setTimeout(done, 50));
      await new Promise((done) => setTimeout(done, 500));
      heldFiles = heavyFiles().length; heldRequests = f.requests.length - asked;
      release(); await holder; foreground = await pending;
    } finally { release?.(); }
    const workspaceOf = (r) => f.row(s.workspaces, r.workspaceId).path;
    assert.equal(nohup.publication.commentOnly, true);
    for (const seen of [nohupSeen, backgroundSeen]) assert.match(seen, /runs a background job/);
    assert.match(nohupSeen, /foreground/);
    assert.ok(!existsSync(resolve(workspaceOf(nohup), "log")), "the backgrounded command must not run");
    assert.equal(background.publication.commentOnly, true);
    assert.ok(!existsSync(resolve(workspaceOf(background), ".scrat/heavy-bg")), "the backgrounded command must not run");
    assert.equal(foreground.error, null, JSON.stringify(foreground.error));
    assert.ok(existsSync(resolve(workspaceOf(foreground), ".scrat/heavy-fg")));
    assert.equal(heldFiles, 0, "the heavy command must not run while another run holds the only slot");
    assert.equal(heldRequests, 1, "the agent gets no tool result while the command waits");
  } },
  validation_slots: { title: "validation waits for a configured number of slots, which a failing validation releases", configure: [configureValidation], run: async () => {
    const { config } = await f.app("config.ts");
    const intervals = (skip) => readFileSync("validations.log", "utf8").trim().split("\n").slice(skip).map(JSON.parse).sort((a, b) => a.s - b.s);
    const both = (first) => { for (const n of [first, first + 1]) { f.addIssue(n, ["scrat"]); f.enqueue(n, "implement"); } return Promise.all([f.runNextTask(), f.runNextTask()]); };
    writeFileSync("slow", "");
    config.harness.maxConcurrentValidations = 1;
    for (const r of await both(1)) assert.equal(r.error, null, JSON.stringify(r.error));
    const serial = intervals(0); assert.equal(serial.length, 2); assert.ok(serial[0].e <= serial[1].s, "one slot serializes validations");
    config.harness.maxConcurrentValidations = 2;
    const validate = config.workspace.validate;
    script(config, "validate", `
      import { appendFileSync, statSync } from "node:fs";
      const arrivals = ${JSON.stringify(resolve("validation-arrivals"))};
      appendFileSync(arrivals, ".");
      const deadline = Date.now() + 15_000;
      while (statSync(arrivals).size < 2) {
        if (Date.now() >= deadline) throw new Error("Second validation never reached the available slot");
        await new Promise((done) => setTimeout(done, 20));
      }
    `, "validate-overlap");
    for (const r of await both(3)) assert.equal(r.error, null, JSON.stringify(r.error));
    config.workspace.validate = validate;
    config.harness.maxConcurrentValidations = 1; writeFileSync("slot-fail", "");
    f.addIssue(5, ["scrat"]); f.enqueue(5, "implement"); assert.equal((await run()).error.exitCode, 7);
    unlinkSync("slot-fail"); f.addIssue(6, ["scrat"]); f.enqueue(6, "implement");
    let expire; const timeout = new Promise((_, reject) => { expire = setTimeout(() => reject(new Error("validation slot was not released")), 30_000); });
    try { assert.equal((await Promise.race([run(), timeout])).error, null); } finally { clearTimeout(expire); }
    const { withValidationSlot } = await f.app("commands.ts");
    let release; const holder = withValidationSlot(() => new Promise((done) => { release = done; }));
    const controller = new AbortController(), ran = [];
    const aborted = withValidationSlot(async () => { ran.push("aborted"); }, {}, controller.signal);
    const next = withValidationSlot(async () => { ran.push("next"); });
    controller.abort(new Error("cancelled"));
    await assert.rejects(aborted, /cancelled/); release(); await holder; await next;
    assert.deepEqual(ran, ["next"]);
  } },
  merge: { title: "retry resumes an unfinished merge and preserves partial work", run: async () => {
    const original = await implement(1); changeMain("src/app.ts", "export const value = 200;\n");
    await route(); f.reset(201, "merge-failure");
    for (const t of all(s.tasks).filter((t) => t.action === "review_pr")) db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, t.id)).run();
    const failed = await run(); assert.ok(failed.error);
    const w = f.row(s.workspaces, original.workspaceId);
    assert.ok(await (await f.app("git.ts")).hasPendingMerge(w.path));
    f.reset(201, "normal"); tasks.retryTask(failed.taskId); const recovered = await success();
    assert.equal(f.requests.findLast((r) => r.context.action === "resolve_conflicts").context.workspace.mergeInProgress, true);
    assert.equal(git(w.path, "show", "-s", "--format=%P").split(" ").length, 2);
    assert.equal(recovered.workspaceId, original.workspaceId);
  } },
  reopen: { title: "fetch-only reopening cannot keep a deleted workspace attached", run: async () => {
    const original = await implement(1); await route();
    f.prs[0].state = "closed"; await route(); assert.ok(f.row(s.workspaces, original.workspaceId).removedAt);
    f.prs[0].state = "open"; await (await f.app("github-sync.ts")).syncGitHub(undefined, false); await route();
    const pr = all(s.items).find((i) => i.kind === "pr"); assert.equal(f.row(s.subjects, pr.id).workspaceId, null);
    assert.ok(all(s.tasks).some((t) => t.subjectId === pr.id && t.status === "queued"));
  } },
  existing_pr: { title: "an existing implementation PR blocks the first selection through merge closure lag", run: async () => {
    await implement(1); f.addIssue(2, ["scrat"]); f.prs[0].body += "\nFixes #2";
    await route();
    const attempts = () => all(s.tasks).filter((t) => t.subjectId === "issue-2" && t.action === "implement");
    assert.deepEqual(attempts().map((t) => t.status), ["blocked"]);
    const [blocked] = attempts();
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
    f.prs[0].state = "closed"; f.prs[0].mergedAt = new Date().toISOString();
    await route();
    assert.deepEqual(attempts().map((t) => [t.id, t.status]), [[blocked.id, "blocked"]]);
    assert.equal(await f.runNextTask(), undefined);
    assert.equal(f.prs.length, 1);
  } },
  trigger_inputs: { title: "every trigger input shape parses to one typed member, a kind-less input is rejected, unknown shapes are rejected clearly and a malformed queued row is rejected at claim", run: async () => {
    const { parseTriggerInput } = await f.app("triggers.ts");
    const items = (kind, fields) => ({ source: "github_items", kind, ...fields });
    const members = [
      items("item_changed", { triggerKey: "k", revision: "r", mainSha: "m", changedPaths: ["a"], previousMainSha: null, previousHeadSha: "h" }),
      items("label", { triggerKey: "k", mainSha: "m" }),
      items("pr_conflicts", { triggerKey: "k", mainSha: "m", headSha: "h" }),
      items("pr_feedback", { triggerKey: "k", commentRevisions: ["c@1"] }),
      items("low_grade", { triggerKey: "k", assessmentRunId: "a", grade: "D" }),
      items("manual", { manual: true }),
      { source: "github_commits", kind: "commit", triggerKey: "s", sha: "s", previousSha: "p", branch: "main", commitCount: 2, truncated: false },
      { source: "schedule", kind: "tick", triggerKey: "2026-10-21T12:00:00.000Z", start: "2026-10-21T06:00:00.000Z", end: "2026-10-21T12:00:00.000Z" },
    ];
    for (const member of members) assert.deepEqual(parseTriggerInput(member), member);
    assert.throws(() => parseTriggerInput(null), /must be an object/);
    assert.throws(() => parseTriggerInput([]), /must be an object/);
    assert.throws(() => parseTriggerInput({ source: "github_items", triggerKey: "k", mainSha: "m" }), /missing its kind/);
    assert.throws(() => parseTriggerInput({ kind: "schedule" }), /Unknown trigger kind: "schedule"/);
    assert.throws(() => parseTriggerInput({ source: "schedule", kind: "label", triggerKey: "k", mainSha: "m" }), /Unknown trigger source for label: "schedule"/);
    assert.throws(() => parseTriggerInput({ source: "github_items", kind: "pr_feedback", triggerKey: "k", commentRevisions: "c@1" }), /Invalid github_items\/pr_feedback trigger input at \/commentRevisions/);
    assert.throws(() => parseTriggerInput({ source: "github_commits", kind: "commit", sha: "s" }), /Invalid github_commits\/commit trigger input/);
    assert.throws(() => parseTriggerInput({ source: "schedule", kind: "tick", triggerKey: "k" }), /Invalid schedule\/tick trigger input at \/: must have required properties start, end/);
    for (let n = 1; n <= 2; n++) f.addIssue(n);
    db.$client.prepare("INSERT INTO tasks (id, subject_id, action, priority, reason, input, created_at) VALUES ('malformed', 'issue-1', 'review_issue', 1000, 'Integration', '{\"source\":\"github_items\",\"kind\":\"pr_feedback\",\"triggerKey\":\"k\",\"commentRevisions\":7}', '2026-01-01')").run();
    f.enqueue(2);
    assert.equal(tasks.claimTask().task.subjectId, "issue-2");
    assert.equal(f.row(s.tasks, "malformed").status, "failed");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1); assert.match(rejected[0].data.reason, /^Invalid trigger input for review_issue: .*commentRevisions/);
  } },
  rejection: { title: "invalid queued tasks are rejected with a journal reason while later work still runs, and a rejected config blocks startup before any task is claimed", run: async () => {
    const rejections = () => all(s.events).filter((e) => e.type === "task.rejected");
    for (let n = 1; n <= 4; n++) f.addIssue(n);
    db.$client.prepare("INSERT INTO tasks (id, subject_id, action, priority, reason, input, created_at) VALUES ('bogus', 'issue-1', 'ship_it', 1000, 'Integration', '{}', '2026-01-01')").run();
    f.enqueue(2);
    const claim = tasks.claimTask();
    assert.equal(claim.task.subjectId, "issue-2");
    assert.equal(f.row(s.tasks, "bogus").status, "failed");
    assert.equal(rejections().length, 1);
    assert.deepEqual({ ...rejections()[0].data, taskId: rejections()[0].taskId }, { action: "ship_it", reason: "Unknown action: ship_it", taskId: "bogus" });
    assert.equal(tasks.claimTask(), undefined);
    tasks.retryTask("bogus"); assert.equal(tasks.claimTask(), undefined);
    assert.equal(rejections().length, 2); assert.equal(f.row(s.tasks, "bogus").status, "failed");
    tasks.finishRun(claim.run.id, { status: "completed" });

    assert.throws(() => tasks.retryTask("bogus", "validation"), /Validation-only retry requires/);

    const { GitHubRepository: Verified } = await f.app("github.ts");
    f.githubApp.slug = "other-app";
    await assert.rejects(new Verified("fixture/project").fetchOpenItems(), /GitHub App other-app posts as other-app\[bot\], but github\.botLogin is scrat-unblock\[bot\]/);
    f.githubApp.slug = "Scrat-Unblock";
    await new Verified("fixture/project").fetchOpenItems();

    assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    const local = resolve("app/scrat.local.json"), requestLog = resolve("startup-requests.log");
    writeFileSync("startup-probe.mjs", `import{appendFileSync}from"node:fs";globalThis.fetch=async(input)=>{appendFileSync(${JSON.stringify(requestLog)},String(input?.url??input)+"\\n");throw new Error("blocked");};await import(${JSON.stringify(resolve("app/src/run-next.ts"))});`);
    const existing = JSON.parse(readFileSync(local, "utf8"));
    const layered = (overrides) => ({ ...existing, ...overrides, workflows: Object.fromEntries([...new Set([...Object.keys(existing.workflows ?? {}), ...Object.keys(overrides.workflows ?? {})])].map((name) => [name, { ...existing.workflows?.[name], ...overrides.workflows?.[name], ...(existing.workflows?.[name]?.config || overrides.workflows?.[name]?.config ? { config: { ...existing.workflows?.[name]?.config, ...overrides.workflows?.[name]?.config } } : {}) }])) });
    const startup = (overrides) => {
      writeFileSync(local, JSON.stringify(layered(overrides)));
      const run = spawnSync(process.execPath, ["startup-probe.mjs"], { encoding: "utf8" });
      return { status: run.status, rejected: /Invalid Scrat configuration/.test(run.stderr) };
    };
    const outbound = () => existsSync(requestLog) ? readFileSync(requestLog, "utf8") : "";
    const modelRequests = f.requests.length;
    const untouched = JSON.stringify([all(s.tasks), all(s.runs)]);
    writeFileSync(local, JSON.stringify(layered({ harness: { maxConcurrentValidations: 0 } })));
    const broken = spawnSync(process.execPath, ["startup-probe.mjs"], { encoding: "utf8" });
    assert.notEqual(broken.status, 0); assert.match(broken.stderr, /Invalid Scrat configuration/);
    assert.equal(outbound(), ""); assert.equal(JSON.stringify([all(s.tasks), all(s.runs)]), untouched, "no task is claimed when the schema rejects the config");
    for (const exhaustedLabel of ["scrat-exhausted", null, ""]) assert.deepEqual(startup({ workflows: { address_review: { config: { exhaustedLabel } } } }), { status: 0, rejected: false });
    f.addIssue(7); f.enqueue(7);
    const before = JSON.stringify([all(s.tasks), all(s.runs)]);
    const base = JSON.parse(readFileSync("app/scrat.config.json", "utf8"));
    writeFileSync("app/scrat.config.json", JSON.stringify({ ...base, workspace: { ...base.workspace, heavyCommands: [] } }));
    for (const overrides of [
      { workflows: { implement: { model: "no-such-model" } } },
      { workflows: { implement: { skill: "workflows/missing/SKILL.md" } } },
      { workspace: { heavyCommands: ["^(unclosed"] } },
      { workflows: { implement: { retry: { initialDelaySeconds: 1, maxDelaySeconds: 2 } } } },
    ]) {
      assert.deepEqual(startup(overrides), { status: 1, rejected: true }, JSON.stringify(overrides));
      assert.equal(JSON.stringify([all(s.tasks), all(s.runs)]), before, "no task is claimed on a rejected start");
    }
    assert.equal(outbound(), ""); assert.equal(f.requests.length, modelRequests);
  } },
  recovery: { title: "recover releases an abandoned claim as an interruption without rewriting the saved result, and an interrupted commit review is recovered and retried with exactly one root and one reply", configure: [configureCommitSource], run: async () => {
    await commitReview("restart");
    f.addIssue(1); f.enqueue(1); const claim = tasks.claimTask();
    db.update(s.runs).set({ stage: "publishing", result: { text: "Saved", ready: false, paths: [], outcome: "complete" }, publication: { status: "pending", commentId: 123 } }).where(eq(s.runs.id, claim.run.id)).run();
    execFileSync(process.execPath, [resolve("app/src/recover.ts"), claim.run.id], { stdio: "pipe" });
    const r = f.row(s.runs, claim.run.id); assert.equal(r.error.code, "RUN_INTERRUPTED"); assert.equal(r.result.text, "Saved"); assert.equal(r.publication.commentId, 123);
    tasks.retryTask(r.taskId); const retried = await success();
    assert.equal(retried.retryOfRunId, null); assert.ok(!("previousFailure" in f.requests.at(-1).context.files), "a recovered run is retried as an interruption, not as a failure to repair");
    const recoverActive = () => execFileSync(process.execPath, [resolve("app/src/recover-active.ts")], { stdio: "pipe" });
    f.addIssue(2); f.enqueue(2); const reviewed = await success(), requests = f.requests.length;
    f.enqueue(2); const validating = tasks.claimTask();
    db.update(s.runs).set({ stage: "validating", result: reviewed.result, context: reviewed.context, mainSha: reviewed.mainSha, headSha: reviewed.headSha }).where(eq(s.runs.id, validating.run.id)).run();
    recoverActive();
    assert.equal(f.row(s.tasks, validating.task.id).status, "queued"); assert.equal(f.row(s.runs, validating.run.id).error.code, "RUN_INTERRUPTED");
    const resumed = await success();
    assert.equal(resumed.retryOfRunId, validating.run.id); assert.equal(resumed.inferenceFromRunId, validating.run.id); assert.equal(resumed.result.text, reviewed.result.text); assert.equal(f.requests.length, requests, "a crash after the agent resumes without a new model request");
    assert.ok(all(s.events).some((event) => event.type === "run.resumed" && event.runId === resumed.id && event.data.reason === "crash" && event.data.stage === "validating"));
    f.enqueue(2); const agent = tasks.claimTask();
    db.update(s.runs).set({ stage: "agent" }).where(eq(s.runs.id, agent.run.id)).run();
    recoverActive();
    assert.equal(f.row(s.tasks, agent.task.id).status, "queued");
    const restarted = await success();
    assert.equal(restarted.retryOfRunId, null); assert.equal(restarted.inferenceFromRunId, null); assert.ok(f.requests.length > requests, "a crash during the agent starts the review over");
    f.addIssue(3); f.enqueue(3); const looping = tasks.claimTask();
    for (let crash = 1; crash <= f.config.harness.crashRequeues; crash++) { db.update(s.runs).set({ stage: "agent" }).where(eq(s.runs.id, tasks.claimTask()?.run.id ?? looping.run.id)).run(); recoverActive(); assert.equal(f.row(s.tasks, looping.task.id).status, "queued", `crash ${crash} re-queues`); }
    tasks.claimTask(); recoverActive();
    assert.equal(f.row(s.tasks, looping.task.id).status, "failed", "a task that crashes the worker past harness.crashRequeues is failed");
  } },
  cleanup: { title: "cleanup failure cannot turn a published review or comment-only implementation into a failed task, and cleanup never removes a change workspace through a review that stopped early", run: async () => {
    f.addIssue(1); f.enqueue(1); f.faults.cleanup.add(1); const r = await success();
    assert.equal(f.row(s.tasks, r.taskId).status, "completed"); const w = f.row(s.workspaces, r.workspaceId);
    assert.equal(w.removedAt, null); assert.equal(readFileSync(w.path + "/keep.txt", "utf8"), "preserve\n");
    git(w.path, "reset", "--hard", w.baseSha); execFileSync(process.execPath, [resolve("app/src/cleanup.ts")], { stdio: "pipe" });
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
    const implemented = await implement(2), pr = all(s.items).find((i) => i.kind === "pr");
    tasks.enqueueTask({ subjectId: pr.id, action: "review_pr", reason: "Stopped before its workspace", input: { source: "github_items", kind: "manual", manual: true } });
    const stop = new AbortController(); stop.abort(); assert.ok((await f.runNextTask(stop.signal)).error);
    execFileSync(process.execPath, [resolve("app/src/cleanup.ts")], { stdio: "pipe" });
    assert.equal(f.row(s.workspaces, implemented.workspaceId).removedAt, null, "cleanup keeps a PR workspace that a stopped review never used");
    tasks.cancelPendingTasks(pr.id, "Isolate the comment-only implementation");
    f.addIssue(3, ["scrat"]); f.reset(3, "no-change"); f.faults.cleanup.add(3); f.enqueue(3, "implement");
    const commented = await success(), kept = f.row(s.workspaces, commented.workspaceId);
    assert.equal(commented.publication.status, "published"); assert.equal(f.comments.get(3).length, 1);
    assert.equal(kept.removedAt, null, "a comment-only release that fails leaves the run completed and the workspace retained");
    assert.equal(readFileSync(kept.path + "/keep.txt", "utf8"), "preserve\n");

    // Retained workspaces strip reinstallable caches (node_modules, .pnpm-store, sandbox-home) while preserving git & tracked files
    const { retainWorkspace, pruneIdleWorkspaceCaches } = await f.app("workspaces.ts");
    const { sandboxHome } = await f.app("sandbox.ts");
    mkdirSync(resolve(kept.path, "node_modules/pkg"), { recursive: true });
    writeFileSync(resolve(kept.path, "node_modules/pkg/index.js"), "x");
    mkdirSync(resolve(kept.path, ".pnpm-store"), { recursive: true });
    mkdirSync(resolve(sandboxHome(kept.id), ".cache"), { recursive: true });
    retainWorkspace(kept.id, "test retention");
    await pruneIdleWorkspaceCaches();
    assert.equal(existsSync(resolve(kept.path, "node_modules")), false, "retained workspace strips node_modules");
    assert.equal(existsSync(resolve(kept.path, ".pnpm-store")), false, "retained workspace strips .pnpm-store");
    assert.equal(existsSync(sandboxHome(kept.id)), false, "retained workspace strips sandbox-home");
    assert.equal(readFileSync(kept.path + "/keep.txt", "utf8"), "preserve\n", "retained workspace preserves source/git recovery files");

    // Closing an issue with no open linked PR cleans up its workspace
    f.addIssue(4, ["scrat"]); f.reset(4, "no-change"); f.enqueue(4, "implement");
    const closedIssueRun = await success();
    const issueWs = f.row(s.workspaces, closedIssueRun.workspaceId);
    if (!issueWs.removedAt) {
      f.issues.get(4).state = "closed";
      await route();
      assert.ok(f.row(s.workspaces, closedIssueRun.workspaceId).removedAt, "closing an issue without an open PR removes its workspace");
    }
  } },
  sync_missing_item: { title: "a deleted open item is marked closed and its failed read does not stop routing for the others", run: async () => {
    f.addIssue(1); f.addIssue(2); await route();
    f.issues.delete(1); f.addIssue(3); await route();
    assert.equal(f.row(s.subjects, "issue-1").state, "closed"); assert.equal(f.row(s.subjects, "issue-2").state, "open");
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-3" && t.status === "queued"));
  } },
  single_repository: { title: "sync, fetch, claims and clone refs refuse any repository other than the configured one", run: async () => {
    const { syncGitHub } = await f.app("github-sync.ts");
    const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = (...args) => { calls.push(args[0]); return realFetch(...args); };
    for (const other of ["other/repo", "Fixture/Project2"]) {
      await assert.rejects(syncGitHub(other), /serves only fixture\/project/);
      await assert.rejects(syncGitHub(other, false), /serves only fixture\/project/);
    }
    const { GitHubRepository } = await f.app("github.ts");
    assert.throws(() => new GitHubRepository("other/repo"), /serves only fixture\/project/);
    assert.equal(calls.length, 0); assert.equal(all(s.items).length, 0);
    await syncGitHub(undefined, false); assert.ok(calls.length > 0);

    f.addIssue(1); f.addIssue(2);
    db.update(s.subjects).set({ repository: "other/repo" }).where(eq(s.subjects.id, "issue-1")).run();
    f.enqueue(1, "review_issue"); f.enqueue(2, "review_issue");
    db.update(s.tasks).set({ priority: 1000 }).where(eq(s.tasks.subjectId, "issue-1")).run();
    assert.equal(tasks.claimTask().task.subjectId, "issue-2");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].data.reason, /Subject belongs to other\/repo, not fixture\/project/);
    assert.equal(f.row(s.tasks, rejected[0].taskId).status, "failed");
    const { upsertItem } = await f.app("items.ts");
    assert.throws(() => upsertItem({ externalId: "elsewhere", kind: "issue", payload: { html_url: "https://example.test/o/r/issues/1" } }), /not on github\.com/);

    const { fetchRepository } = await f.app("git.ts");
    const checkout = f.config.github.repositoryPath, remote = "https://github.com/fixture/project.git";
    const base = await fetchRepository(checkout, remote, "main");
    assert.equal(git(checkout, "config", "--get", "remote.origin.url"), remote);
    for (const url of ["git@github.com:Fixture/Project.git", "ssh://git@github.com/fixture/project", "https://github.com/FIXTURE/project"]) {
      git(checkout, "remote", "set-url", "origin", url);
      assert.equal(await fetchRepository(checkout, remote, "main"), base);
    }
    for (const [index, url] of ["https://github.com/other/repo.git", "git@github.com:fixture/project-fork.git", "https://example.com/fixture/project.git"].entries()) {
      git(checkout, "remote", "set-url", "origin", url);
      changeMain("src/app.ts", `export const value = ${index + 2};\n`);
      const before = git(checkout, "rev-parse", "refs/remotes/origin/main");
      await assert.rejects(fetchRepository(checkout, remote, "main"), /has origin .* not https:\/\/github\.com\/fixture\/project\.git/);
      assert.equal(git(checkout, "rev-parse", "refs/remotes/origin/main"), before);
    }
    const { serialized } = await f.app("single-flight.ts");
    const locks = new Map(), order = []; let release;
    const first = serialized(locks, "k", async () => { order.push("start1"); await new Promise((done) => { release = done; }); order.push("end1"); });
    const second = serialized(locks, "k", async () => { order.push("start2"); });
    await Promise.resolve(); assert.deepEqual(order, ["start1"]);
    release(); await Promise.all([first, second]);
    assert.deepEqual(order, ["start1", "end1", "start2"]); assert.equal(locks.size, 0);
    const failing = serialized(locks, "k", async () => { throw new Error("first"); }), after = serialized(locks, "k", async () => "ok");
    const [failed, ran] = await Promise.allSettled([failing, after]);
    assert.equal(failed.reason.message, "first"); assert.equal(ran.value, "ok"); assert.equal(locks.size, 0);
  } },
  identity: { title: "retained workspaces reject branch replacement and retain unpublished commits", run: async () => {
    const original = await implement(1); const w = f.row(s.workspaces, original.workspaceId);
    const { removeWorkspace } = await f.app("workspaces.ts");
    git(w.path, "switch", "-c", "replacement");
    f.enqueue(1, "implement"); const calls = f.requests.length;
    const failed = await run(); assert.match(failed.error.message, /identity changed/);
    assert.equal(f.requests.length, calls); await assert.rejects(removeWorkspace(w.id), /identity changed/);
    git(w.path, "switch", w.branch); writeFileSync(w.path + "/unpublished.txt", "retain\n");
    git(w.path, "add", "."); commit(w.path, "Unpublished work");
    await assert.rejects(removeWorkspace(w.id), /unpublished commits/);
    assert.equal(readFileSync(w.path + "/unpublished.txt", "utf8"), "retain\n");
    f.prs[0].state = "closed"; f.addIssue(2); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-2" && t.status === "queued"));
  } },
  feedback: { title: "edited review summaries and same-commit PR retargets produce fresh tasks", run: async () => {
    await implement(1); await route(); await success();
    const ignored = { id: 9000, body: "My own follow-up", user: { login: f.config.github.botLogin }, updated_at: "2026-10-19T02:00:00Z", html_url: "https://github.com/fixture/project/pull/201#comment" };
    f.comments.get(201).push(ignored, { ...ignored, id: 9001, body: " \n\t ", user: { login: "human" } });
    await route();
    assert.ok(!all(s.tasks).some((task) => task.status === "queued"), "Bot and empty comments must not change review or feedback context");
    const summary = { id: 55, body: "Please change the implementation", user: { login: "human" }, submitted_at: "2026-10-19T00:00:00Z", html_url: "https://github.com/fixture/project/pull/201#review" };
    f.reviews.set(201, [summary]); await route(); await success(); await success();
    summary.body = "Edited request with different requirements"; await route();
    assert.ok(all(s.tasks).some((t) => t.action === "address_pr_feedback" && t.status === "queued"));
    const before = all(s.tasks).find((t) => t.action === "review_pr" && t.status === "queued").input.triggerKey;
    git(resolve("remote.git"), "update-ref", "refs/heads/alternate", git(resolve("remote.git"), "rev-parse", "main"));
    f.prs[0].base.ref = "alternate"; await route();
    const after = all(s.tasks).find((t) => t.action === "review_pr" && t.status === "queued").input.triggerKey;
    assert.notEqual(after, before);
  } },
  git_paging: { title: "git and read_base page bounded output from files and diffs larger than the 16 MiB buffer without loading them", seed: seedGitPaging, run: async () => {
    await implement(1);
    const branch = f.prs[0].head.ref;
    git(".", "clone", "-b", branch, resolve("remote.git"), "pr-edit");
    writeFileSync("pr-edit/src/huge.txt", ("b".repeat(63) + "\n").repeat(18 * 16384));
    git(resolve("pr-edit"), "add", "."); commit(resolve("pr-edit"), "Rewrite huge file"); git(resolve("pr-edit"), "push", "origin", branch);
    await route();
    const review = await success();
    const hugeSize = 64 * (17 * 16384 + 10), midSize = readFileSync("seed/src/mid.txt").length, mid = readFileSync("seed/src/mid.txt", "latin1");
    const mine = f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === "gpt-6.2-sol").at(-1);
    const results = mine.request.messages.filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : m.content.map((part) => part.text ?? "").join(""));
    assert.equal(results.length, 11, results.map((text) => text.slice(0, 80)).join("\n"));
    const [, first, second, multibyte, show, diff, diffNext, deep, stat, missing, whole] = results;
    assert.ok(first.length < 33_000 && first.startsWith(mid.slice(0, 100)) && first.includes(`truncated: bytes 0-32768 of ${midSize}`) && first.includes("offset=32768"), first.slice(-200));
    assert.ok(second.startsWith(mid.slice(32768, 33792)) && second.includes(`bytes 32768-33792 of ${midSize}`) && second.includes("offset=33792"), second.slice(-200));
    assert.ok(multibyte.includes("bytes 0-1000 of 6000") && multibyte.includes("offset=1000"), multibyte.slice(-200));
    assert.ok(show.length < 1300 && show.startsWith(("a".repeat(63) + "\n").repeat(2)) && show.includes(`bytes 0-1024 of ${hugeSize}`), show.slice(-200));
    const expected = execFileSync("git", ["-C", resolve("remote.git"), "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", mine.context.diffBaseSha, f.prs[0].head.sha, "--", "src/huge.txt"], { maxBuffer: 1 << 28 });
    assert.ok(expected.length > 32 * 1024 * 1024);
    assert.ok(diff.startsWith(expected.subarray(0, 1024).toString()) && diff.includes("truncated: bytes 0-1024; more output exists") && diff.includes("offset=1024"), diff.slice(-200));
    assert.ok(diffNext.startsWith(expected.subarray(1024, 2048).toString()) && diffNext.includes("bytes 1024-2048") && diffNext.includes("offset=2048"), diffNext.slice(-200));
    assert.ok(deep.includes(`bytes 10000000-10001024 of ${18 * 16384 * 64}`), deep.slice(-200));
    assert.ok(stat.includes("src/huge.txt"), stat.slice(0, 200));
    assert.ok(/does not exist|exists on disk, but not in|fatal/.test(missing), missing);
    assert.ok(whole.startsWith("diff --git a/") && whole.includes("offset=1024"), whole.slice(0, 200));
    assert.ok(review.result.paths.includes("src/huge.txt") && review.result.paths.includes("src/mid.txt"), "paged paths join review scope");
  } },
  self_repair: { title: "low grades on Scrat PRs queue one capped address_review repair per assessment that receives the report; good grades, human PRs and pending feedback do not", configure: [configureValidation], run: async () => {
    const prItem = (n) => all(s.items).find((i) => i.kind === "pr" && i.payload.number === n);
    const repairs = (n) => all(s.tasks).filter((t) => t.subjectId === prItem(n).id && t.action === "address_review");
    const count = (n) => db.$client.prepare("select self_repair_count as c from items where id = ?").get(prItem(n).id).c;
    const review = async (n, mode) => { f.reset(n, mode); await route(); return success(); };
    const implemented = await implement(1);
    assert.ok(implemented.verification.commands.length > 0 && implemented.verification.commands.every((c) => c.status === "passed"));
    const validated = `Validated on ${implemented.headSha.slice(0, 7)}: ${implemented.verification.commands.map((c) => c.name).join(", ")} passed.`;
    assert.ok(f.prs.find((pr) => pr.number === 201).body.includes(`\n\n${validated}\n\nCloses #1`));
    const graded = await review(201, "grade-C");
    const reviewed = f.requests.findLast((r) => r.context.action === "review_pr").context.files.validation;
    const listing = readFileSync(reviewed, "utf8");
    assert.ok(listing.includes(implemented.headSha));
    for (const c of implemented.verification.commands) assert.ok(listing.includes(`- ${c.name}: passed (`));
    assert.equal(graded.result.grade, "C"); await route();
    assert.equal(repairs(201).length, 1); assert.equal(repairs(201)[0].status, "queued"); assert.equal(repairs(201)[0].input.assessmentRunId, graded.id);
    assert.equal(count(201), 0, "A queued repair spends no cap slot until it runs"); await route(); assert.equal(repairs(201).length, 1); assert.equal(count(201), 0);
    const validations = () => readFileSync("validations.log", "utf8").trim().split("\n").length, validationsBefore = validations();
    f.reset(201, "no-change"); const repair = await success();
    assert.equal(validations(), validationsBefore, "A repair that changed nothing skips validation");
    assert.equal(repair.verification, null); assert.equal(repair.publication.status, "published");
    assert.equal(repair.taskId, repairs(201)[0].id);
    const request = f.requests.findLast((r) => r.context.action === "address_review");
    assert.match(readFileSync(request.context.files.review, "utf8"), /Consolidated source-verified review/);
    assert.equal(readFileSync(request.context.files.issue, "utf8"), "# Issue 1 (#1)\n\nInspect app.ts\n");
    assert.equal(f.comments.get(201).length, 2); assert.match(f.comments.get(201)[1].body, /Implemented the change/);
    await route(); assert.equal(all(s.tasks).filter((t) => t.status === "queued").length, 0, "A reply-only repair leaves the assessment current and cannot retrigger");
    assert.equal(repairs(201).length, 1); assert.equal(count(201), 1);
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(201).id); await route();
    assert.ok(f.prs.find((pr) => pr.number === 201).labels.some((label) => label.name === "Scrat repair exhausted"), "A last repair that changed nothing still marks the PR");
    await implement(2); db.$client.prepare("update runs set verification = null").run(); await review(202, "normal");
    assert.equal(f.requests.findLast((r) => r.context.action === "review_pr").context.files.validation, undefined, "A head with no stored verification gets no validation file"); await route(); assert.equal(repairs(202).length, 0, "Grade B does not trigger");
    await implement(3); f.prs.find((pr) => pr.number === 203).user.login = "human";
    f.checkRuns.set(f.prs.find((pr) => pr.number === 203).head.sha, [{ name: "ci / build", conclusion: "success" }, { name: "ci / lint", conclusion: "failure" }, { name: "ci / deploy", conclusion: null }]);
    await review(203, "grade-C");
    const combined = readFileSync(f.requests.findLast((r) => r.context.action === "review_pr").context.files.validation, "utf8");
    assert.ok(combined.includes("- ci / build: success\n- ci / lint: failure\n") && !combined.includes("ci / deploy") && combined.includes("# Validation run by"), "Scrat and GitHub checks share the validation file");
    await route(); assert.equal(repairs(203).length, 0, "Human-authored PRs never trigger");
    await implement(4); await review(204, "grade-C");
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(204).id);
    const labels204 = () => f.prs.find((pr) => pr.number === 204).labels.map((label) => label.name).filter((name) => name === "Scrat repair exhausted").length;
    assert.equal(labels204(), 0, "Below the cap there is no exhausted label");
    await route(); assert.equal(repairs(204).length, 0, "The cap blocks further repairs");
    assert.equal(labels204(), 1, "A low grade at the cap is labelled");
    const labelWrites = () => f.written("label", (w) => w.number === 204 && w.method !== "GET").length;
    const written = labelWrites(); await route(); assert.equal(labels204(), 1); assert.equal(labelWrites(), written, "A steady state writes no label");
    db.$client.prepare("update items set self_repair_count = 1 where id = ?").run(prItem(204).id);
    await route(); assert.equal(repairs(204).length, 1); assert.equal(count(204), 1);
    const queuedRepair = repairs(204)[0], before = count(204);
    tasks.enqueueTask({ subjectId: queuedRepair.subjectId, action: "address_review", reason: "Coalesce", input: queuedRepair.input });
    assert.equal(count(204), before, "A coalesced repair does not spend a cap slot");
    assert.throws(() => tasks.enqueueManualTasks("address_review", ["204"]), /queued automatically/);
    touchPr(204); await route();
    assert.equal(repairs(204)[0].status, "cancelled", "A repair for a stale assessment is cancelled");
    assert.equal(labels204(), 1, "The label waits for the next review");
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(204).id);
    await success(); await route(); assert.equal(repairs(204).length, 1, "A new low grade at the cap queues nothing");
    assert.equal(labels204(), 1, "Still low at the cap");
    touchPr(204); await route(); f.reset(204, "normal"); assert.equal((await success()).result.grade, "B"); await route();
    assert.equal(labels204(), 0, "A better grade removes the label");
    await implement(5);
    f.comments.set(205, [humanComment(205, 9100, "Please rename it", "2026-10-19T01:00:00Z")]);
    assert.equal((await review(205, "grade-C")).result.grade, "C"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === prItem(205).id && t.action === "address_pr_feedback" && t.status === "queued"));
    assert.equal(repairs(205).length, 0, "Pending human feedback goes first");
    tasks.cancelPendingTasks(prItem(205).id, "Drain"); await implement(6); await review(206, "grade-C"); await route(); assert.equal(repairs(206)[0].status, "queued");
    f.comments.set(206, [humanComment(206, 9200, "Please rename it", "2026-10-19T01:00:00Z")]);
    await route(); assert.equal(repairs(206)[0].status, "cancelled", "Human feedback arriving later cancels the queued repair");
    for (const pr of f.prs) pr.state = "closed";
    await route(); await implement(7); await review(207, "grade-C"); await route();
    assert.equal(repairs(207)[0].status, "queued");
    tasks.enqueueManualTasks("review_pr", ["207"]); await route();
    assert.equal(repairs(207)[0].status, "cancelled", "A queued review cancels the queued repair");
    f.prs.find((pr) => pr.number === 207).state = "closed"; await route();
    await implement(8); const graded8 = await review(208, "grade-C"); await route();
    const repair8 = repairs(208)[0]; assert.equal(repair8.status, "queued"); assert.equal(repair8.input.assessmentRunId, graded8.id);
    tasks.enqueueManualTasks("review_pr", ["208"]); f.reset(208, "grade-A");
    const regraded = await success(); assert.equal(regraded.result.grade, "A");
    const guarded = "The review this repair addresses is no longer the current assessment";
    const modelCalls = f.requests.length, head208 = () => git(resolve("remote.git"), "rev-parse", f.prs.find((pr) => pr.number === 208).head.ref);
    const headBefore = head208(); f.reset(208, "no-change");
    const superseded = await run(); assert.equal(superseded.taskId, repair8.id); assert.equal(superseded.error.message, guarded);
    assert.equal(f.requests.length, modelCalls, "no model call"); assert.equal(head208(), headBefore, "no push");
    assert.equal(f.row(s.tasks, repair8.id).status, "failed");
    await implement(10); const graded10 = await review(210, "grade-C"); await route();
    assert.equal(repairs(210)[0].status, "queued"); assert.equal(count(210), 0, "A queued repair spends no cap slot until it runs");
    tasks.cancelPendingTasks(prItem(210).id, "Human feedback", "address_review"); assert.equal(repairs(210)[0].status, "cancelled");
    await route(); const requeued10 = repairs(210).find((t) => t.status === "queued");
    assert.equal(repairs(210).length, 2); assert.equal(requeued10.input.assessmentRunId, graded10.id);
    assert.equal(count(210), 0, "Re-queuing the same assessment after a cancel spends no cap slot");
    f.reset(210, "no-change"); const repaired10 = await success(); assert.equal(repaired10.taskId, requeued10.id);
    assert.equal(count(210), 1, "One claimed repair counts once"); await route();
    assert.equal(repairs(210).length, 2); assert.equal(count(210), 1);
    await implement(9); await review(209, "grade-C"); await route();
    const repair9 = repairs(209)[0]; assert.equal(repair9.status, "queued");
    const branch9 = f.prs.find((pr) => pr.number === 209).head.ref;
    git(".", "clone", "-b", branch9, resolve("remote.git"), "pr-edit-209");
    writeFileSync("pr-edit-209/src/app.ts", "export const value = 4242;\n");
    git(resolve("pr-edit-209"), "add", "."); commit(resolve("pr-edit-209"), "Human change"); git(resolve("pr-edit-209"), "push", "origin", branch9);
    const calls9 = f.requests.length, head9 = git(resolve("remote.git"), "rev-parse", branch9); f.reset(209, "no-change");
    const moved = await run(); assert.equal(moved.taskId, repair9.id); assert.equal(moved.error.message, guarded);
    assert.equal(f.requests.length, calls9); assert.equal(git(resolve("remote.git"), "rev-parse", branch9), head9);
  } },
  review_prior_assessment: { title: "a re-review of a Scrat PR after a pushed repair gives both panel reviewers and the consolidator the previous assessment and repair summary; a re-review of a human PR after a pushed file gets the previous assessment and head; first reviews get neither; implementation gets its issue's latest review when that review was ready, and reviews of a Scrat PR get the issue it implements while a human PR naming that issue does not", run: async () => {
    const review = async (n, mode) => { f.reset(n, mode); await route(); return success(); };
    const filesOf = (number, assessmentId) => f.requests.filter((r) => r.context.action === "review_pr" && r.context.item.number === number && r.context.files.directory.includes(assessmentId));
    const implementFiles = () => f.requests.findLast((r) => r.context.action === "implement").context.files;
    f.addIssue(1); f.reset(1, "ready"); f.enqueue(1); const triage = await success(); assert.ok(triage.result.ready);
    f.reset(1, "normal"); f.enqueue(1, "implement"); await success();
    assert.equal(readFileSync(implementFiles().triage, "utf8"), triage.result.text, "Implementation gets the ready triage");
    const first = await review(201, "grade-C");
    const firstRequests = f.requests.filter((r) => r.context.action === "review_pr");
    assert.ok(firstRequests.some((r) => r.consolidating));
    for (const request of firstRequests) {
      assert.ok(!("previous_assessment" in request.context.files) && !("previous_repair" in request.context.files), "A first review has no prior state");
      assert.equal(readFileSync(request.context.files.issue, "utf8"), "# Issue 1 (#1)\n\nInspect app.ts\n", "A Scrat PR review gets the issue it implements");
    }
    await route(); f.reset(201, "normal"); const repair = await success();
    assert.equal(repair.taskId, all(s.tasks).find((t) => t.action === "address_review").id); assert.ok(repair.result.text.includes("Implemented the change"));
    const repaired201 = f.prs.find((pr) => pr.number === 201);
    assert.equal(git(resolve("remote.git"), "log", "-1", "--format=%s", repaired201.head.ref), `Address review: ${repaired201.title}`);
    await route(); f.reset(201, "normal"); const second = await success();
    assert.notEqual(second.id, first.id);
    const secondRequests = filesOf(201, second.id);
    assert.equal(new Set(secondRequests.filter((r) => !r.consolidating).map((r) => r.request.model)).size, 2); assert.ok(secondRequests.some((r) => r.consolidating));
    for (const request of secondRequests) {
      assert.ok(!("history" in request.context.files), "PR reviews keep the #50 files instead of a history file");
      assert.equal(readFileSync(request.context.files.previous_assessment, "utf8"), first.result.text);
      assert.equal(readFileSync(request.context.files.previous_repair, "utf8"), repair.result.text);
    }
    await implement(2); assert.ok(!("triage" in implementFiles()), "An unreviewed issue has no triage");
    f.prs.find((pr) => pr.number === 202).user.login = "human";
    const humanFirst = await review(202, "grade-C");
    const humanFirstRequests = f.requests.filter((r) => r.context.item.number === 202 && r.context.action === "review_pr");
    assert.ok(humanFirstRequests.length && humanFirstRequests.every((r) => !("previous_assessment" in r.context.files) && !("previous_repair" in r.context.files)), "A human PR's first review has no prior state");
    const humanBranch = f.prs.find((pr) => pr.number === 202).head.ref, firstHead = git(resolve("remote.git"), "rev-parse", humanBranch);
    const humanHead = pushFile(humanBranch, "human-note.txt", "A follow-up change\n");
    const humanSecond = await review(202, "normal");
    assert.notEqual(humanSecond.id, humanFirst.id); assert.equal(humanSecond.headSha, humanHead);
    const humanSecondRequests = filesOf(202, humanSecond.id);
    assert.equal(new Set(humanSecondRequests.filter((r) => !r.consolidating).map((r) => r.request.model)).size, 2); assert.ok(humanSecondRequests.some((r) => r.consolidating));
    for (const request of humanSecondRequests) {
      assert.equal(request.context.previous?.headSha, firstHead, "A human re-review names the previous head");
      assert.equal(readFileSync(request.context.files.previous_assessment, "utf8"), humanFirst.result.text);
      assert.ok(!("previous_repair" in request.context.files), "A human PR has no repair summary");
    }
    git(resolve("remote.git"), "branch", "human-feature", "main"); const humanFeature = pushFile("human-feature", "src/human.ts", "export const human = 1;\n");
    git(resolve("remote.git"), "update-ref", "refs/pull/303/head", humanFeature);
    f.addPr(303, "human-feature", "human", { title: "Human change", body: "Closes #1" });
    await route(); await success();
    const humanPrRequests = f.requests.filter((r) => r.context.action === "review_pr" && r.context.item.number === 303);
    assert.ok(humanPrRequests.length && humanPrRequests.every((r) => !("issue" in r.context.files)), "A human PR naming an issue gets no issue file");
    f.addIssue(3); f.reset(3, "ready"); f.enqueue(3); await success(); f.reset(3, "normal"); f.enqueue(3); await success();
    f.reset(3, "normal"); f.enqueue(3, "implement"); await success();
    assert.ok(!("triage" in implementFiles()), "A later review that is not ready supersedes the ready triage");
  } },
  issue_effect: { title: "SCRAT_ISSUE footer blocks parse only at the end of the report, and the issue effect creates each fingerprint once, skips receipted and marker-matched issues, and creates nothing when any block leaks a secret", run: async () => {
    const { applyEffects } = await f.app("effects.ts");
    const { GitHubRepository } = await f.app("github.ts");
    const github = new GitHubRepository("fixture/project");
    const created = () => f.written("issue");
    const apply = async (saved, receipts = {}) => {
      let publication = { status: "pending", ...receipts };
      await applyEffects(["issue"], { references: {}, publication: () => publication, saveReceipt: (patch) => { publication = { ...publication, ...patch }; }, github, run: saved });
      return publication;
    };
    const reporting = (saved, ...issues) => ({ ...saved, result: { ...saved.result, issues: issues.map(([fingerprint, title]) => ({ title, fingerprint, body: `Body of ${title}` })) } });
    const marker = (fingerprint) => `<!-- scrat-fingerprint:${fingerprint} -->`;

    f.addIssue(1); f.reset(1, "issues"); f.enqueue(1);
    const reviewed = await success();
    assert.deepEqual(reviewed.result.issues, [
      { title: "Broken link", fingerprint: "link:docs-a", body: "The link on docs/a is broken." },
      { title: "Slow page", fingerprint: "perf:home", body: "Home takes 9s.\n\n```\ntrace\n```" },
    ]);
    assert.match(reviewed.result.text, /title: Quoted/); assert.ok(!reviewed.result.text.includes("Broken link"));
    const first = await apply(reviewed);
    assert.equal(created().length, 2);
    assert.deepEqual(Object.keys(first.issues), ["link:docs-a", "perf:home"]);
    for (const [fingerprint, number] of Object.entries(first.issues)) {
      assert.ok(f.issues.get(number).body.endsWith(`\n\n${marker(fingerprint)}`), "the marker closes the body");
      assert.equal(f.issues.get(number).user.login, f.config.github.botLogin);
    }
    assert.equal(first.status, "published");
    assert.deepEqual(await apply(reviewed), { ...first, issues: first.issues }, "a second run with the same fingerprints creates nothing");
    assert.equal(created().length, 2);

    f.issues.set(60, { ...f.issues.get(1), number: 60, node_id: "ISSUE_60", user: { login: f.config.github.botLogin }, body: `Quoting ${marker("new:one")} in the middle\n\nof the text` });
    f.issues.set(61, { ...f.issues.get(1), number: 61, node_id: "ISSUE_61", user: { login: "human" }, body: `Someone else\n\n${marker("new:two")}` });
    const fresh = await apply(reporting(reviewed, ["new:one", "New one"], ["new:two", "New two"]));
    assert.equal(created().length, 4, "quoted markers and other users' issues never block creation");
    assert.ok(fresh.issues["new:one"] > 500 && fresh.issues["new:two"] > 500);

    const resumed = await apply(reporting(reviewed, ["part:one", "Part one"], ["part:two", "Part two"]), { issues: { "part:one": 77 } });
    assert.equal(created().length, 5); assert.equal(created().at(-1).title, "Part two");
    assert.equal(resumed.issues["part:one"], 77); assert.ok(resumed.issues["part:two"] > 500);

    f.issues.get(first.issues["perf:home"]).state = "closed";
    const recurred = await apply(reporting(reviewed, ["perf:home", "Slow page"]));
    assert.equal(created().length, 6, "a closed issue does not block a recurrence");
    assert.notEqual(recurred.issues["perf:home"], first.issues["perf:home"]);

    f.faults.issue.add("Lost one");
    await assert.rejects(apply(reporting(reviewed, ["lost:one", "Lost one"])), (error) => error.status === 502);
    assert.equal(created().length, 7);
    const found = await apply(reporting(reviewed, ["lost:one", "Lost one"]));
    assert.equal(created().length, 7, "the marker scan finds an issue whose response was lost");
    assert.equal(f.issues.get(found.issues["lost:one"]).title, "Lost one");

    const leaking = reporting(reviewed, ["ok:one", "Fine"], ["leak:two", "Leaky"]);
    leaking.result.issues[1].body = process.env.GITHUB_APP_PRIVATE_KEY;
    await assert.rejects(apply(leaking), (error) => error.code === "SECRET_IN_OUTPUT");
    assert.equal(created().length, 7, "a secret in any block creates no issue at all");
    await assert.rejects(apply(reporting(reviewed, ["bad --> <!-- x", "Bad"])), /fingerprint/);
    assert.equal(created().length, 7);

    f.addIssue(2); f.reset(2, "issues-quoted"); f.enqueue(2);
    assert.equal((await success()).result.issues, undefined, "a quoted block creates nothing");
    f.addIssue(3); f.reset(3, "issues-bad"); f.enqueue(3);
    const before = f.requests.length, bad = await run();
    assert.match(bad.error.message, /fingerprint/); assert.equal(f.requests.length - before, 4, "a malformed block gets the correction turns");
  } },
  history_file: { title: "a subject with earlier completed runs of an action gets a bounded newest-first history file; first runs and other subjects get none", configure: [configureHistory], run: async () => {
    const seen = [], directories = new Set();
    f.onModel = (context) => {
      if (directories.has(context.files.directory)) return;
      directories.add(context.files.directory); seen.push(context.files.history ? readFileSync(context.files.history, "utf8") : undefined);
    };
    f.addIssue(1); f.addIssue(2);
    const review = async (number) => { const before = f.requests.length; f.enqueue(number); const r = await success(); return { r, request: f.requests[before] }; };
    const rewrite = (r, text, extra = {}) => db.update(s.runs).set({ result: { ...r.result, text }, ...extra }).where(eq(s.runs.id, r.id)).run();

    const firstRun = await review(1);
    assert.equal(firstRun.request.context.files.history, undefined, "a first run has no history"); assert.equal(seen[0], undefined);
    rewrite(firstRun.r, "report 1", { publication: { status: "published", issues: { "link:docs-a": 12 } } });
    const other = await review(2); rewrite(other.r, "other subject report");
    assert.match(seen[1], /## #1, .*, complete\n/, "a new subject sees earlier runs of the action, headed by their item number");
    const implemented = await implement(3); rewrite(implemented, "implement report");
    assert.equal(seen[2], undefined, "another action's runs are not history");
    const runs = [firstRun.r];
    for (let n = 2; n <= 12; n++) { const { r } = await review(1); rewrite(r, `report ${n}`); runs.push(r); }
    assert.equal(seen.length, 14);
    const second = seen[3];
    assert.match(second, /untrusted/); assert.match(second, /report 1\b/); assert.match(second, /Issues opened: #12 \(link:docs-a\)/);
    assert.match(second, /, complete\n/); assert.ok(second.includes("## #2,") && second.includes("other subject report"), "other subjects' runs are included with their labels");
    assert.ok(!second.includes("implement report"));
    const last = seen[13];
    assert.ok(last.indexOf("report 11") < last.indexOf("report 10") && last.indexOf("report 10") < last.indexOf("report 9"), "newest first");
    assert.ok(!/report 1\b/.test(last), "the history keeps the newest three runs");
    assert.equal((last.match(/^## /gm) ?? []).length, 3);
    const { config } = await f.app("config.ts");
    config.context.historyRuns = 5; await review(1);
    assert.equal((seen.at(-1).match(/^## /gm) ?? []).length, 5); config.context.historyRuns = 3;
    const { r: huge, request } = await review(1);
    assert.match(request.context.files.history, /history\.md$/);
    rewrite(huge, "x".repeat(200 * 1024));
    await review(1);
    const capped = seen.at(-1);
    assert.ok(Buffer.byteLength(capped) <= 12 * 1024 && Buffer.byteLength(capped) > 10 * 1024, Buffer.byteLength(capped) + capped.slice(0, 300));
    assert.ok(capped.includes("## ") && !capped.includes("report 10"), "a report over the cap crowds out older ones");
    config.context.historyBytes = 2048; await review(1);
    assert.ok(Buffer.byteLength(seen.at(-1)) <= 2048 && Buffer.byteLength(seen.at(-1)) > 1500);
    const { buildAgentInput } = await f.app("agent-input.ts"), { workflowOf } = await f.app("workflow-registry.ts"), { toWorkflowSpec } = await f.app("workflows.ts"), manifest = toWorkflowSpec(workflowOf("review_issue"), { publish: ["comment", "labels"] });
    const sha = "a".repeat(40), evaluated = { revision: "r", baseBranch: "main", headSha: undefined, item: { number: 1, title: "t", body: "", url: "u" }, comments: [], commentRevisions: [] };
    const build = async (paths) => JSON.parse((await buildAgentInput({ run: huge, task: f.row(s.tasks, huge.taskId), manifest, evaluated, diffBaseSha: sha, diffPaths: paths, mainSha: sha, headSha: sha, baseRef: "main", mergeInProgress: false, workspace: { path: "w", branch: null } })).prompt);
    assert.deepEqual((await build(["a", "b", "c"])).diffPaths, ["a", "b", "c"]);
    config.context.inlinePaths = 2;
    const offloaded = await build(["a", "b", "c"]);
    assert.equal(offloaded.diffPathCount, 3); assert.equal(offloaded.diffPaths, undefined); assert.equal(readFileSync(offloaded.files.diffPaths, "utf8"), "a\nb\nc\n");
  } },
  commit_hook: { title: "commit hooks cannot attach verification receipts to an unverified tree", run: async () => {
    f.addIssue(1); f.enqueue(1, "implement");
    f.onModel = (_context, step) => {
      if (step) return;
      const hook = resolve(all(s.workspaces).at(-1).path, ".git/hooks/pre-commit");
      copyFileSync(hook + ".sample", hook);
      writeFileSync(hook, '#!/bin/sh\nprintf "export const value = 909;\\n" > src/app.ts\ngit add src/app.ts\n');
    };
    const r = await run(); assert.match(r.error.message, /Committed tree differs/);
    assert.equal(r.verification, null); assert.equal(f.prs.length, 0);
  } },
  publish_existing_branch: { title: "a retained workspace whose push was rejected publishes a new commit onto the existing PR branch when retried", run: async () => {
    const first = await implement(1), remote = resolve("remote.git"), branch = f.prs[0].head.ref, workspace = f.row(s.workspaces, first.workspaceId);
    assert.ok(fs.lstatSync(resolve(workspace.path, ".git")).isDirectory());
    const item = all(s.items).find((i) => i.kind === "pr" && i.payload.number === 201);
    f.script = [{ name: "bash", args: { command: "printf 'export const value = 14;\\n' > src/app.ts" } }];
    tasks.enqueueTask({ subjectId: item.id, action: "address_pr_feedback", reason: "Publish onto the existing branch", input: { source: "github_items", kind: "manual", manual: true } });
    f.reset(201, "normal");
    writeFileSync(resolve(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const rejected = await run();
    assert.ok(rejected.error); assert.equal(rejected.stage, "publishing"); assert.equal(git(remote, "rev-parse", branch), first.publication.commitSha);
    unlinkSync(resolve(remote, "hooks/pre-receive"));
    tasks.retryTask(rejected.taskId); const retried = await success();
    assert.equal(retried.publication.status, "published"); assert.notEqual(retried.publication.commitSha, first.publication.commitSha);
    assert.equal(git(remote, "rev-parse", branch), retried.publication.commitSha);
    assert.equal(git(remote, "show", `${retried.publication.commitSha}:src/app.ts`), "export const value = 14;");
    assert.equal(f.prs.length, 1);
  } },
  pr_head_routing: { title: "routing sees the API head of a PR whose refs/pull head is frozen behind it, so a conflict only the newer head has queues an update", run: async () => {
    await implement(1);
    const remote = resolve("remote.git"), branch = f.prs[0].head.ref, item = all(s.items).find((i) => i.kind === "pr" && i.payload.number === 201);
    tasks.cancelPendingTasks(item.id, "Isolate"); await route(); tasks.cancelPendingTasks(item.id, "Isolate");
    f.frozen.add(201);
    git(".", "clone", "-b", branch, remote, "pr-edit");
    writeFileSync("pr-edit/src/conflict.ts", "export const conflict = 'pr';\n");
    git(resolve("pr-edit"), "add", "."); commit(resolve("pr-edit"), "Add conflicting file"); git(resolve("pr-edit"), "push", "origin", branch);
    changeMain("src/conflict.ts", "export const conflict = 'main';\n");
    await route();
    assert.notEqual(git(remote, "rev-parse", "refs/pull/201/head"), git(remote, "rev-parse", branch));
    assert.equal(all(s.tasks).filter((t) => t.subjectId === item.id && t.status === "queued" && t.action === "resolve_conflicts").length, 1);
  } },
  behind_unpublished: { title: "a retained workspace holding a commit the shared repository has never seen is merged with a behind main in code, without the agent", run: async () => {
    const first = await implement(1), remote = resolve("remote.git"), workspace = f.row(s.workspaces, first.workspaceId);
    const item = all(s.items).find((i) => i.kind === "pr" && i.payload.number === 201);
    tasks.cancelPendingTasks(item.id, "Isolate");
    writeFileSync(resolve(workspace.path, "src/local.ts"), "export const local = 1;\n");
    git(workspace.path, "add", "."); commit(workspace.path, "Unpublished work");
    const local = git(workspace.path, "rev-parse", "HEAD");
    assert.throws(() => git(f.config.github.repositoryPath, "cat-file", "-e", local + "^{commit}"));
    changeMain("src/other.ts", "export const other = 1;\n");
    const calls = f.requests.length;
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Merge main", input: { source: "github_items", kind: "manual", manual: true } });
    const merged = await success();
    assert.equal(f.requests.length, calls, "a clean update needs no model");
    const head = git(remote, "rev-parse", f.prs[0].head.ref);
    assert.equal(merged.publication.publishedCommitSha, head);
    git(remote, "merge-base", "--is-ancestor", local, head);
    git(remote, "merge-base", "--is-ancestor", git(resolve("seed"), "rev-parse", "main"), head);

    // A diverged retained workspace is marked retained and replaced by a fresh workspace on a new PR task, repointing linked subjects too.
    writeFileSync(resolve(workspace.path, "src/diverged.ts"), "export const diverged = 1;\n");
    git(workspace.path, "add", "."); commit(workspace.path, "Unpushed local commit");
    const remoteUpdate = pushFile(f.prs[0].head.ref, "src/remote-only.ts", "export const remoteOnly = 1;\n");
    f.prs[0].head.sha = remoteUpdate;
    changeMain("src/other2.ts", "export const other2 = 2;\n");
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Recover diverged PR workspace", input: { source: "github_items", kind: "manual", manual: true } });
    const recovered = await success();
    assert.notEqual(recovered.workspaceId, workspace.id);
    assert.equal(f.row(s.subjects, "issue-1").workspaceId, recovered.workspaceId, "linked issue subject is repointed along with the PR subject");
    assert.ok(f.row(s.workspaces, workspace.id).retainedAt, "diverged workspace is retained rather than deleted");
    assert.equal(readFileSync(resolve(workspace.path, "src/diverged.ts"), "utf8"), "export const diverged = 1;\n");

    // A pending merge on an older PR head is retained and replaced cleanly once remote moves ahead.
    const pendingWorkspace = f.row(s.workspaces, recovered.workspaceId);
    changeMain("src/other-pending.ts", "export const pending = 1;\n");
    const pendingMain = git(remote, "rev-parse", "main");
    git(pendingWorkspace.path, "fetch", "--no-tags", "--", remote, pendingMain);
    git(pendingWorkspace.path, "merge", "--no-commit", "--no-ff", pendingMain);
    const humanResolved = pushFile(f.prs[0].head.ref, "src/human-resolved.ts", "export const human = 1;\n");
    f.prs[0].head.sha = humanResolved;
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Recover pending merge behind remote", input: { source: "github_items", kind: "manual", manual: true } });
    const afterPending = await success();
    assert.notEqual(afterPending.workspaceId, pendingWorkspace.id);
    assert.ok(f.row(s.workspaces, pendingWorkspace.id).retainedAt, "stale pending-merge workspace is retained rather than overwritten");

    // Uncommitted edits on an older PR head are retained and replaced cleanly once remote advances, never committed onto the new head.
    const dirtyWorkspace = f.row(s.workspaces, afterPending.workspaceId);
    writeFileSync(resolve(dirtyWorkspace.path, "src/abandoned.ts"), "export const abandoned = 1;\n");
    const afterDirtyHead = pushFile(f.prs[0].head.ref, "src/after-dirty.ts", "export const afterDirty = 1;\n");
    f.prs[0].head.sha = afterDirtyHead;
    changeMain("src/other3.ts", "export const other3 = 3;\n");
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Recover dirty workspace behind remote", input: { source: "github_items", kind: "manual", manual: true } });
    const afterDirty = await success();
    f.prs[0].head.sha = afterDirty.publication.publishedCommitSha;
    assert.notEqual(afterDirty.workspaceId, dirtyWorkspace.id);
    assert.ok(f.row(s.workspaces, dirtyWorkspace.id).retainedAt, "dirty workspace behind remote head is retained rather than fast-forwarded");
    assert.equal(readFileSync(resolve(dirtyWorkspace.path, "src/abandoned.ts"), "utf8"), "export const abandoned = 1;\n");
    assert.throws(() => git(remote, "cat-file", "-e", `${afterDirty.publication.publishedCommitSha}:src/abandoned.ts`), "abandoned uncommitted edits are never published");

    // Fast-forwarding a PR workspace to a new remote head updates workspaces.baseSha so closing without new commits removes it cleanly instead of falsely retaining it.
    const ffWorkspace = f.row(s.workspaces, afterDirty.workspaceId);
    const externalHead = pushFile(f.prs[0].head.ref, "src/external-ff.ts", "export const ext = 1;\n");
    f.prs[0].head.sha = externalHead;
    f.reset(201, "normal"); f.script = ["Replied without code changes.\nSCRAT_STATUS: complete"];
    tasks.enqueueTask({ subjectId: item.id, action: "address_pr_feedback", reason: "Comment-only after human push", input: { source: "github_items", kind: "manual", manual: true } });
    await success(); f.script = undefined;
    assert.equal(f.row(s.workspaces, ffWorkspace.id).baseSha, externalHead, "PR fast-forward updates workspaces.baseSha");
    f.prs[0].state = "closed";
    await route();
    assert.ok(f.row(s.workspaces, ffWorkspace.id).removedAt && !f.row(s.workspaces, ffWorkspace.id).retainedAt, "closing a fast-forwarded PR without unpublished commits removes the workspace cleanly");
    f.prs[0].state = "open";
    await route();
    tasks.cancelPendingTasks(item.id, "Isolate");

    // Closing a PR whose workspace has unpublished commits marks it retained once instead of error-looping on every sync.
    changeMain("src/other4.ts", "export const other4 = 4;\n");
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Create fresh workspace before close", input: { source: "github_items", kind: "manual", manual: true } });
    const beforeClose = await success();
    f.prs[0].head.sha = beforeClose.publication.publishedCommitSha;
    const activeWorkspace = f.row(s.workspaces, beforeClose.workspaceId);
    writeFileSync(resolve(activeWorkspace.path, "src/unpushed-on-close.ts"), "export const keep = 1;\n");
    git(activeWorkspace.path, "add", "."); commit(activeWorkspace.path, "Unpushed before close");
    f.prs[0].state = "closed";
    await route();
    assert.ok(f.row(s.workspaces, activeWorkspace.id).retainedAt, "closed PR unpublished workspace is marked retained");
    const retainedEvents = () => all(s.events).filter((e) => e.type === "workspace.retained" && e.data.workspaceId === activeWorkspace.id).length;
    assert.equal(retainedEvents(), 1);
    const lines = captureLogs();
    try { await route(); } finally { restoreLogs(); }
    assert.equal(retainedEvents(), 1);
    assert.ok(!lines.some((line) => line.operation === "workspace.remove" && line.event === "operation.failed"), "subsequent syncs do not retry removing retained workspaces");

    // Reopening a closed PR whose workspace was retained detaches the retained workspace and publishes from a fresh checkout.
    f.prs[0].state = "open";
    await route();
    assert.equal(f.row(s.subjects, item.id).workspaceId, null, "reopened PR detaches retained workspace");
    tasks.cancelPendingTasks(item.id, "Isolate");
    changeMain("src/other5.ts", "export const other5 = 5;\n");
    tasks.enqueueTask({ subjectId: item.id, action: "resolve_conflicts", reason: "Merge after reopen", input: { source: "github_items", kind: "manual", manual: true } });
    const reopened = await success();
    assert.notEqual(reopened.workspaceId, activeWorkspace.id);
    assert.equal(f.row(s.subjects, item.id).workspaceId, reopened.workspaceId);
    assert.equal(readFileSync(resolve(activeWorkspace.path, "src/unpushed-on-close.ts"), "utf8"), "export const keep = 1;\n");
  } },
  workspace_layout: { title: "workspaces share objects that a shared-repository gc cannot remove, and publication bundles only the new commits with a full-bundle fallback", run: async () => {
    const first = await implement(1), shared = f.config.github.repositoryPath, remote = resolve("remote.git");
    const { createWorkspace, pushWorkspace } = await f.app("workspaces.ts");
    const row = () => f.row(s.workspaces, first.workspaceId);
    const pin = (id) => `refs/scrat/workspaces/${id}`;
    assert.equal(git(shared, "rev-parse", pin(row().id)), git(remote, "rev-parse", row().branch));
    assert.ok(existsSync(resolve(row().path, ".git/objects/info/alternates")));
    const header = () => readFileSync(resolve(row().path, ".scrat/publish.bundle"), "latin1").split("\n").filter((line) => line.startsWith("-"));
    const publish = async (name) => {
      writeFileSync(resolve(row().path, name), name + "\n"); git(row().path, "add", "."); commit(row().path, name);
      const sha = git(row().path, "rev-parse", "HEAD");
      await pushWorkspace(row(), remote, sha, git(remote, "rev-parse", row().branch), { ...process.env });
      assert.equal(git(remote, "rev-parse", row().branch), sha);
      return sha;
    };
    const published = git(remote, "rev-parse", row().branch);
    await publish("one.txt");
    assert.equal(header().length, 1); assert.ok(header()[0].startsWith("-" + published));
    const incremental = fs.statSync(resolve(row().path, ".scrat/publish.bundle")).size;
    git(row().path, "bundle", "create", resolve(row().path, ".scrat/full.bundle"), "refs/heads/" + row().branch);
    const full = fs.statSync(resolve(row().path, ".scrat/full.bundle")).size;
    assert.ok(incremental < full, `${incremental} < ${full}`);
    console.log(`BUNDLE_BYTES incremental=${incremental} full=${full}`);
    writeFileSync(resolve(row().path, "local.txt"), "local\n"); git(row().path, "add", "."); commit(row().path, "local");
    const local = git(row().path, "rev-parse", "HEAD");
    db.update(s.workspaces).set({ baseSha: local }).where(eq(s.workspaces.id, row().id)).run();
    git(shared, "update-ref", "-d", pin(row().id));
    await publish("two.txt");
    assert.deepEqual(header(), []);
    git(remote, "merge-base", "--is-ancestor", local, row().branch);
    const observed = git(remote, "rev-parse", row().branch), rewind = git(remote, "rev-parse", "main");
    writeFileSync(resolve(row().path, "next.txt"), "next\n"); git(row().path, "add", "."); commit(row().path, "Next");
    const next = git(row().path, "rev-parse", "HEAD"), branch = `refs/heads/${row().branch}`;
    git(remote, "update-ref", branch, rewind, observed);
    await assert.rejects(pushWorkspace(row(), remote, next, observed, { ...process.env }), /stale info/);
    assert.equal(git(remote, "rev-parse", branch), rewind, "A push cannot undo an intervening rewind");
    const tree = git(shared, "rev-parse", "HEAD^{tree}"), head = git(shared, "rev-parse", "HEAD");
    const orphan = () => git(shared, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", head, "-m", "orphan " + Math.random());
    const [kept, lost] = [orphan(), orphan()];
    const retained = await createWorkspace({ repositoryPath: shared, baseRef: kept });
    assert.equal(git(shared, "rev-parse", pin(retained.id)), kept);
    git(shared, "reflog", "expire", "--expire=now", "--all"); git(shared, "gc", "--prune=now", "--quiet");
    assert.throws(() => git(shared, "cat-file", "-e", lost + "^{commit}"));
    git(retained.path, "cat-file", "-e", kept + "^{commit}");
    assert.equal(git(retained.path, "rev-parse", "HEAD"), kept);
    git(retained.path, "fsck", "--connectivity-only");
    const { removeWorkspace } = await f.app("workspaces.ts");
    await removeWorkspace(retained.id);
    assert.throws(() => git(shared, "rev-parse", "--verify", pin(retained.id)));
  } },
  sandbox: { title: "Linux sandbox contains preparation, agent Bash and commit hooks while a fresh clone validates and publishes", needsSandbox: true,
    seed: () => {
      writeFileSync("outside-secret.txt", "controller-only-canary");
      writeFileSync("seed/sandbox-probe.mjs", `import{strict as assert}from"node:assert";import{readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync}from"node:fs";
        assert.throws(()=>readFileSync(${JSON.stringify(resolve("outside-secret.txt"))}));
        try{writeFileSync(${JSON.stringify(resolve("outside-write.txt"))},"escaped")}catch{}
        assert.throws(()=>writeFileSync("/usr/bin/scrat-write-canary","escaped"));
        assert.equal(existsSync("/proc/${process.pid}/environ"),false);
        assert.equal(process.env.DOCKER_HOST,undefined);assert.equal(process.env.GITHUB_APP_PRIVATE_KEY,undefined);
        assert.match(readFileSync("/proc/self/status","utf8"),/NoNewPrivs:\\s+1/);
        mkdirSync(".scrat",{recursive:true});appendFileSync(".scrat/sandbox-proof.jsonl",JSON.stringify({phase:process.argv[2]})+"\\n");`);
    },
    configure: [(config) => { config.workspace = { ...config.workspace, sandbox: true, prepare: [[process.execPath, "sandbox-probe.mjs", "prepare"]], validate: [[process.execPath, "sandbox-probe.mjs", "validate"]] }; }],
    run: async () => {
      f.script = [
        { name: "bash", args: { command: `${process.execPath} sandbox-probe.mjs bash && printf 'export const value = 13;\\n' > src/app.ts` } },
        { name: "bash", args: { command: `printf '#!/bin/sh\\nexec ${process.execPath} sandbox-probe.mjs hook\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` } },
      ];
      const result = await implement(1);
      assert.equal(result.publication.status, "published");
      assert.equal(git(resolve("remote.git"), "show", `${result.publication.commitSha}:src/app.ts`), "export const value = 13;");
      const workspace = f.row(s.workspaces, result.workspaceId);
      assert.ok(fs.lstatSync(resolve(workspace.path, ".git")).isDirectory());
      const pr = result.publication.pullRequestNumber, prItem = all(s.items).find((i) => i.kind === "pr" && i.payload.number === pr);
      f.script = [{ name: "bash", args: { command: `printf 'export const value = 14;\\n' > src/app.ts` } }];
      tasks.enqueueTask({ subjectId: prItem.id, action: "address_pr_feedback", reason: "Publish onto the existing branch", input: { source: "github_items", kind: "manual", manual: true } });
      f.reset(pr, "normal"); const followUp = await success();
      assert.equal(followUp.publication.status, "published"); assert.notEqual(followUp.publication.commitSha, result.publication.commitSha);
      assert.equal(git(resolve("remote.git"), "rev-parse", f.prs[0].head.ref), followUp.publication.commitSha);
      assert.equal(git(resolve("remote.git"), "show", `${followUp.publication.commitSha}:src/app.ts`), "export const value = 14;");
      const proof = readFileSync(resolve(workspace.path, ".scrat/sandbox-proof.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual([...new Set(proof.map((row) => row.phase))].sort(), ["bash", "hook", "prepare", "validate"]);
      assert.equal(existsSync("outside-write.txt"), false);
      assert.equal(readFileSync("outside-secret.txt", "utf8"), "controller-only-canary");
      const { removeWorkspace } = await f.app("workspaces.ts");
      await removeWorkspace(workspace.id);
      assert.equal(existsSync(workspace.path), false);
      assert.equal(existsSync(resolve("data/sandbox-homes", workspace.id)), false);
    } },
  package_store: { title: "a configured package store is shared read-write across sandboxed workspaces", needsSandbox: true,
    configure: [(config) => {
      const store = "/home/scrat/.local/share/pnpm/store";
      config.workspace = { ...config.workspace, sandbox: true, validate: [], packageStore: resolve("shared-store"), prepare: [["sh", "-c", `pnpm store path > ${store}/path && if [ -f ${store}/marker ]; then touch ${store}/seen; else touch ${store}/marker; fi`]] };
    }],
    run: async () => {
      for (const number of [1, 2]) {
        f.addIssue(number, ["scrat"]); f.enqueue(number, "implement");
        f.script = [{ name: "bash", args: { command: `printf 'export const value = 1${number};\\n' > src/app.ts` } }];
        assert.equal((await success()).publication.status, "published");
      }
      assert.equal(readFileSync(resolve("shared-store/path"), "utf8").trim(), "/home/scrat/.local/share/pnpm/store/v11");
      assert.ok(existsSync(resolve("shared-store/marker")));
      assert.ok(existsSync(resolve("shared-store/seen")));
    } },
  command_memory: { title: "a sandboxed command that exceeds workspace.commandMemoryMax is killed alone, fails the run as out of memory without re-prompting the agent and accepts validation-only retry", needsSandbox: true, needsSystemd: true,
    configure: [(config) => {
      config.workspace = { ...config.workspace, sandbox: true, commandMemoryMax: "128M", environment: { ALLOCATE_MB: "512" }, validate: [[process.execPath, "-e", "const n=Number(process.env.ALLOCATE_MB);const held=[];for(let i=0;i<n;i++){const b=Buffer.alloc(1024*1024);b.fill(1);held.push(b);}console.log('allocated',held.length);"]] };
    }],
    run: async () => {
      f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
      const failed = await run();
      assert.ok(failed.error); assert.equal(failed.error.code, "COMMAND_OUT_OF_MEMORY"); assert.equal(failed.stage, "validating");
      assert.match(failed.error.message, /workspace\.commandMemoryMax \(128M\).*out of memory/);
      assert.equal(f.requests.length, 2, "agent turn only");
      assert.equal(f.prs.length, 0);
      const { config: live } = await f.app("config.ts");
      live.workspace.environment.ALLOCATE_MB = "1";
      tasks.retryTask(failed.taskId, "validation");
      const retried = await success();
      assert.equal(retried.publication.status, "published");
    } },
  isolation: { title: "workspace commands, hooks and agent tools cannot reach Scrat credentials, and credential material is never published; a commit review never sees the Slack token, reads base files and diffs against the previous SHA, and installs nothing", seed: seedIsolation, configure: [configureIsolation, configureCommitSource], run: async () => {
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    f.addIssue(1); f.reset(1, "outside"); f.enqueue(1); await success();
    const transcript = f.requests.filter(({ context }) => context.item.number === 1).at(-1).request.messages;
    assert.equal(transcript.filter((message) => message.role === "tool" && JSON.stringify(message.content).includes("outside the workspace")).length, 4);
    assert.ok(!JSON.stringify(f.requests.map(({ request }) => request.messages)).includes("outside-secret-content"));
    const reviewTools = f.requests.filter(({ context }) => context.item.number === 1).at(-1).request.tools.map((tool) => tool.function.name);
    assert.ok(!reviewTools.includes("edit") && !reviewTools.includes("write"));
    f.addIssue(5, ["scrat"]); f.reset(5, "outside-write"); f.enqueue(5, "implement"); const confined = await success();
    const attempts = f.requests.filter(({ context }) => context.item.number === 5).at(-1).request.messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
    assert.equal(attempts.length, 7);
    assert.ok(attempts.slice(0, 5).every((text) => text.includes("outside the workspace")));
    assert.ok(attempts.slice(5).every((text) => !text.includes("outside the workspace")));
    assert.deepEqual(readdirSync("outside-dir"), []);
    assert.equal(readFileSync(resolve(f.row(s.workspaces, confined.workspaceId).path, "src/new/file.ts"), "utf8"), "export const added = 1;\n");
    assert.equal(readFileSync("outside-secret.txt", "utf8"), "outside-secret-content\n");
    assert.equal(existsSync("outside-new.txt"), false);
    assert.equal(existsSync(resolve(f.row(s.workspaces, confined.workspaceId).path, "../outside.txt")), false);
    assert.equal(git(f.row(s.workspaces, confined.workspaceId).path, "show", "HEAD:src/app.ts"), "export const value = 9;");
    f.addIssue(2); f.reset(2, "leak-report"); f.enqueue(2);
    const report = await run(); assert.equal(report.error.code, "SECRET_IN_OUTPUT");
    assert.ok(!f.writes.some((write) => write.number === 2));
    f.onModel = (context, step) => {
      if (step || context.action !== "implement" || context.item.number !== 3) return;
      for (const name of ["pre-commit", "pre-push"]) {
        const hook = resolve(all(s.workspaces).at(-1).path, ".git/hooks", name);
        copyFileSync(hook + ".sample", hook); writeFileSync(hook, `#!/bin/sh\nexec ${process.execPath} ${resolve("probe.mjs")} ${name}\n`);
      }
    };
    f.addIssue(3, ["scrat"]); f.reset(3, "probe"); f.enqueue(3, "implement"); await success();
    const probes = readFileSync("isolation.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual([...new Set(probes.map(({ phase }) => phase))].sort(), ["bash", "pre-commit", "prepare", "validate"]);
    for (const probe of probes) {
      assert.deepEqual(probe.leaked, [], JSON.stringify(probe));
      if (probe.phase !== "pre-commit") assert.equal(probe.configured, "isolated");
    }
    f.addIssue(4, ["scrat"]); f.reset(4, "leak-file"); f.enqueue(4, "implement");
    const committed = await run(); assert.equal(committed.error.code, "SECRET_IN_OUTPUT");
    assert.equal(committed.verification, null); assert.ok(!f.writes.some((write) => write.type === "pr" && write.number === 4));
    assert.ok(!JSON.stringify(all(s.runs).map((r) => r.error)).includes(key.split("\n")[1]));
    const { containsSecret } = await f.app("secrets.ts"), body = key.split("\n").slice(1, -2).join("");
    assert.ok(containsSecret(`x ${body.slice(0, 40)} x`) && containsSecret(`x ${body.slice(10, 50)} x`) && containsSecret(`x ${body.slice(20, 60)} x`));
    assert.ok(!containsSecret(body.slice(0, 39)));
    const { redactSecrets } = await f.app("errors.ts"), header = Buffer.from("x-access-token:" + f.pat).toString("base64");
    assert.ok(containsSecret(f.pat) && containsSecret(header));
    assert.ok(!redactSecrets(`${f.pat} ${header}`).includes(f.pat.slice(4)) && !redactSecrets(header).includes(header.slice(8)));
    await commitReview("isolation");
  } },
  wakeup: { title: "idle workers wake on enqueue, keep signals sent while busy, fall back on timeout and release on abort", run: async () => {
    const { signalWork, waitForWork, workGeneration } = await f.app("work-signal.ts");
    const timed = async (promise) => { const start = Date.now(); await promise; return Date.now() - start; };
    f.addIssue(1);
    const woken = await timed(((since) => { const waiting = waitForWork(since, 5_000); f.enqueue(1); return waiting; })(workGeneration()));
    assert.ok(woken < 1000, `Enqueue should wake the waiter, took ${woken}ms`);
    f.addIssue(2); const since = workGeneration(); f.enqueue(2);
    const retained = await timed(waitForWork(since, 5_000));
    assert.ok(retained < 1000, `A signal sent before waiting must not be lost, took ${retained}ms`);
    const fallback = await timed(waitForWork(workGeneration(), 100));
    assert.ok(fallback >= 90 && fallback < 1000, `Timeout should resolve the waiter, took ${fallback}ms`);
    const controller = new AbortController();
    const aborted = await timed(((waiting) => { controller.abort(); return waiting; })(waitForWork(workGeneration(), 5_000, controller.signal)));
    assert.ok(aborted < 1000, `Abort should release the waiter, took ${aborted}ms`);
    const notified = await timed(((since) => { const waiting = waitForWork(since, 5_000); signalWork(); return waiting; })(workGeneration()));
    assert.ok(notified < 1000, `Explicit signal should wake the waiter, took ${notified}ms`);
  } },
  config_overrides: { title: "scrat.local.json overrides merge over the defaults, are created when missing, reject unknown settings and reach Pi's providers", run: async () => {
    const { buildConfig } = await f.app("config-merge.ts");
    const local = resolve("app/scrat.local.json");
    const probe = (overrides, code) => {
      if (overrides === undefined) rmSync(local, { force: true }); else writeFileSync(local, JSON.stringify(overrides));
      const script = `const { config } = await import(${JSON.stringify(resolve("app/src/config.ts"))}); ${code}`;
      return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    const defaults = { ...JSON.parse(readFileSync("app/scrat.config.json", "utf8")), workflows: JSON.parse(probe({}, "console.log(JSON.stringify(config.workflows));")) };
    const rejected = (overrides, message) => assert.throws(() => buildConfig(defaults, overrides), message);
    const merged = buildConfig(defaults, {
      harness: { maxConcurrency: 8 }, github: { auth: "pat" }, workflows: { implement: { model: "other-model" } },
      workspace: { environment: { EXTRA: "1" }, heavyCommands: ["^only$"], database: null },
    });
    assert.equal(merged.harness.maxConcurrency, 8); assert.equal(merged.harness.logLevel, defaults.harness.logLevel);
    assert.equal(merged.github.auth, "pat"); assert.equal(defaults.github.auth, "app"); assert.equal(merged.github.botLogin, defaults.github.botLogin);
    assert.equal(merged.workflows.implement.model, "other-model");
    assert.deepEqual({ ...merged.workflows.implement, model: defaults.workflows.implement.model }, defaults.workflows.implement);
    assert.deepEqual(merged.workspace.environment, { ...defaults.workspace.environment, EXTRA: "1" });
    assert.deepEqual(merged.workspace.heavyCommands, ["^only$"]); assert.equal(merged.workspace.database, null);
    assert.deepEqual(merged.workspace.validate, defaults.workspace.validate);

    probe(undefined, ""); assert.equal(readFileSync(local, "utf8"), "{}\n");
    rejected(JSON.parse('{"workspace":{"environment":{"__proto__":{"x":"1"}}}}'), /Unknown setting in scrat\.local\.json: workspace\.environment\.__proto__/);
    assert.throws(() => probe({ actions: { bogus: {} } }, ""), (error) => /Invalid Scrat configuration[\s\S]*actions: unknown setting/.test(error.stderr));
    assert.throws(() => probe({ workflows: { bogus: {} } }, ""), (error) => /Invalid Scrat configuration[\s\S]*workflows\.bogus/.test(error.stderr));
    assert.throws(() => probe({ harness: { maxConcurency: 8 } }, ""), (error) => /Invalid Scrat configuration[\s\S]*harness\.maxConcurency/.test(error.stderr));

    const provider = Object.keys(defaults.providers)[0], model = defaults.providers[provider].models[0].id;
    const seen = probe({ providers: { [provider]: { baseUrl: "http://override.invalid/v1" } } }, `
      const { sharedModelRuntime } = await import(${JSON.stringify(resolve("app/src/model-runtime.ts"))});
      const runtime = await sharedModelRuntime(); console.log("BASE " + runtime.getModel(${JSON.stringify(provider)}, ${JSON.stringify(model)})?.baseUrl);`);
    assert.match(seen, /^BASE http:\/\/override\.invalid\/v1$/m);
    const written = JSON.parse(readFileSync("data/pi-models.json", "utf8")).providers[provider];
    assert.equal(written.baseUrl, "http://override.invalid/v1"); assert.equal(written.apiKey, defaults.providers[provider].apiKey);
    assert.deepEqual(written.models, defaults.providers[provider].models);

    const labelConfig = {
      targets: ["issues", "prs"],
      issue_labels: [{ category: "type", choices: [{ name: "bug", description: "A reported defect" }] }],
      pr_labels: [{ category: "risk", choices: [{ name: "custom: low", description: "Our deployment's low-risk rule" }] }],
    };
    const labels = { enabled: true, provider: "fixture", model: "gpt-6.2-sol", config: labelConfig };
    const overrides = { workflows: { ...f.config.workflows, label_items: labels } };
    const showLabels = "console.log(JSON.stringify(config.workflows.label_items));";
    const beforeUpgrade = JSON.parse(probe(overrides, showLabels));
    const manifestPath = resolve("app/workflows/label_items/workflow.yaml"), shipped = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, shipped.replace("gpt-6.1-terra", "deepseek/deepseek-v4.1-flash").replace("category: risk", "category: upgraded-risk").replace("risk: low", "upgraded: low"));
    assert.deepEqual(JSON.parse(probe(overrides, showLabels)), beforeUpgrade, "a new shipped default cannot overwrite deployment label settings");
    assert.deepEqual(beforeUpgrade.config.pr_labels, labelConfig.pr_labels, "category arrays replace the shipped choices in full");
    assert.deepEqual(beforeUpgrade.config.issue_labels, labelConfig.issue_labels);
    assert.equal(beforeUpgrade.model, "gpt-6.2-sol");
    assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), overrides, "loading does not rewrite local overrides");
    writeFileSync(manifestPath, shipped);
    const validate = `const { validateStaticConfig } = await import(${JSON.stringify(resolve("app/src/startup.ts"))}); await validateStaticConfig();`;
    probe(overrides, validate);
    const invalidLabels = (changes, message) => assert.throws(() => probe({ workflows: { ...f.config.workflows, label_items: { ...labels, config: { ...labelConfig, ...changes } } } }, validate), (error) => message.test(error.stderr));
    invalidLabels({ issue_labels: [] }, /issues target requires non-empty issue_labels/);
    invalidLabels({ pr_labels: [{ category: "risk", choices: [{ name: "Low", description: "low" }, { name: "low", description: "same" }] }] }, /label names must be unique/);
    invalidLabels({ issue_labels: [...labelConfig.issue_labels, { category: "TYPE", choices: [{ name: "feature", description: "New behavior" }] }] }, /category names must be unique/);
    invalidLabels({ pr_labels: [{ category: "risk", choices: [] }] }, /Invalid Scrat configuration|minItems|must NOT have fewer than 1 items/);
  } },
  pat_auth: { title: "a personal access token authenticates every GitHub call and git credential without the App, is redacted, and must belong to botLogin case-insensitively", configure: [configurePat], run: async () => {
    const { GitHubRepository } = await f.app("github.ts"), { containsSecret } = await f.app("secrets.ts"), { redactSecrets } = await f.app("errors.ts");
    const repository = new GitHubRepository("fixture/project");
    f.user.login = "someone-else";
    await assert.rejects(repository.fetchOpenItems(), /GITHUB_PAT belongs to someone-else, but github\.botLogin is agent-account/);
    f.user.login = "Agent-Account"; f.user.status = 401;
    await assert.rejects(repository.fetchOpenItems(), (error) => error.status === 401 && /GitHub rejected GITHUB_PAT \(401\)/.test(error.message));
    f.user.status = 200;
    process.env.GITHUB_PAT = ""; await assert.rejects(repository.fetchOpenItems(), /GITHUB_PAT is not set/); process.env.GITHUB_PAT = f.pat;
    await repository.fetchOpenItems();

    await implement(1); assert.equal(f.prs.length, 1);
    await route(); await success();
    assert.match(f.comments.get(201)[0].body, /Consolidated/);
    f.comments.get(201).push({ ...f.comments.get(201)[0], id: 9000, body: "Mixed-case own follow-up", user: { login: "Agent-Account" } });
    await route();
    assert.ok(!all(s.tasks).some((task) => task.status === "queued"), "The PAT account's own comments must not be treated as feedback");
    f.comments.get(201).push(humanComment(201, 9001, "Please rename the value", "2026-10-19T01:00:00Z"));
    await route();
    await success(); await success();
    assert.ok(all(s.tasks).some((task) => task.action === "address_pr_feedback" && task.status === "completed"));

    assert.ok(f.calls.length > 10 && f.calls.every((call) => call.token === f.pat), "Every GitHub call must carry the PAT");
    assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
    const header = Buffer.from("x-access-token:" + f.pat).toString("base64");
    assert.equal((await repository.getGitEnvironment(true)).GIT_CONFIG_VALUE_0, "Authorization: Basic " + header);
    assert.equal((await repository.getGitEnvironment(false)).GIT_CONFIG_VALUE_0, "Authorization: Basic " + header);
    assert.ok(containsSecret(`x ${f.pat} x`) && containsSecret(`x ${header} x`));
    assert.ok(!redactSecrets(`${f.pat} ${header}`).includes(f.pat.slice(4)) && !redactSecrets(header).includes(header.slice(8)));
    assert.equal(git(resolve("remote.git"), "log", "-1", "--format=%an", f.prs[0].head.ref), "agent-account");
    assert.ok(f.writes.some((write) => write.type === "pr") && f.writes.some((write) => write.type === "comment") && f.writes.some((write) => write.type === "label"));
  } },
  bot_name: { title: "a configured bot name replaces every prose mention of Scrat in model requests across all actions while protocol markers stay", configure: [configureValidation, botName("Mocha")], run: async () => {
    const drain = async () => { for (let n = 0; n < 12 && all(s.tasks).some((t) => t.status === "queued"); n++) await success(); };
    f.addIssue(1, ["scrat"]); f.reset(1, "feedback-fix"); f.enqueue(1, "implement"); await success();
    f.addIssue(2); f.enqueue(2, "review_issue"); await success();
    await route(); await drain();
    f.comments.get(201).push(humanComment(201, 9001, "Please rename the value", "2026-10-19T01:00:00Z"));
    await route(); await drain();
    f.reset(201, "resolve"); changeMain("src/app.ts", "export const value = 99;\n"); await route();
    for (const t of all(s.tasks).filter((t) => t.action === "review_pr" && t.status === "queued")) db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, t.id)).run();
    await drain();
    f.reset(201, "grade-C"); tasks.enqueueManualTasks("review_pr", ["201"]); await route(); await drain(); await route(); await drain();
    const actions = new Set(f.requests.map((r) => r.context.action));
    assert.deepEqual([...actions].sort(), ["address_pr_feedback", "address_review", "implement", "resolve_conflicts", "review_issue", "review_pr"]);
    assert.ok(f.requests.some((r) => r.consolidating) && f.requests.some((r) => r.request.model.includes("deepseek")));
    const prompts = f.requests.map((r) => JSON.stringify(r.request.messages) + JSON.stringify(r.request.tools ?? []));
    assert.ok(prompts.every((text) => !/Scrat(?!_)/.test(text)), "No model request may name Scrat");
    assert.ok(prompts.every((text) => text.includes("Mocha") && !text.includes("{{bot}}") && text.includes("SCRAT_STATUS")));
    assert.ok(prompts.some((text) => text.includes("Mocha's validation failed")));
  } },
  bot_identity_names: { title: "the selection label, its routing reason and the new branch prefix follow the bot name while the default scrat label stops selecting", configure: [botName("Mocha Agent")], run: async () => {
    const queued = () => all(s.tasks).filter((t) => t.status === "queued");
    f.addIssue(1, ["scrat"]); f.addIssue(2, ["mocha-agent"]); await route();
    assert.deepEqual(queued().map((t) => [t.subjectId, t.action]).sort(), [["issue-1", "review_issue"], ["issue-2", "implement"]]);
    assert.equal(queued().find((t) => t.subjectId === "issue-2").reason, "Issue has the mocha-agent label");
    await success(); await success();
    const labels = (n) => f.issues.get(n).labels.map((label) => label.name);
    f.addIssue(3); f.reset(3, "ready"); f.enqueue(3, "review_issue"); await success();
    assert.deepEqual(labels(3), ["mocha-agent"]);
    assert.equal(f.prs.length, 1); assert.match(f.prs[0].head.ref, /^mocha-agent\/[0-9a-f-]{36}$/);
    assert.deepEqual(labels(1), ["scrat"]);
  } },
  slack_client: { title: "the Slack client posts and replies in threads, retries one 429, surfaces outages and Slack errors, caps and escapes text", run: async () => {
    const token = ["xoxb", "1111", "2222", "fixturetoken"].join("-");
    process.env.SLACK_BOT_TOKEN = token;
    const { postMessage, authTest, escapeSlack } = await f.app("slack.ts");
    const root = await postMessage({ channel: "C1", text: "root" });
    const rootCall = f.slack.calls.at(-1);
    assert.equal(rootCall.method, "chat.postMessage"); assert.equal(rootCall.token, token);
    assert.deepEqual({ ...rootCall.body }, { channel: "C1", text: "root", unfurl_links: false, unfurl_media: false, link_names: false });
    const reply = await postMessage({ channel: "C1", text: "reply", threadTs: root });
    assert.notEqual(reply, root); assert.equal(f.slack.calls.at(-1).body.thread_ts, root);
    assert.equal((await authTest()).ok, true); assert.equal(f.slack.calls.at(-1).method, "auth.test");
    const before = f.slack.calls.length; f.slack.rateLimitOnce = true;
    assert.ok(await postMessage({ channel: "C1", text: "after limit" }));
    assert.equal(f.slack.calls.length, before + 2);
    const { config: slackConfig } = await f.app("config.ts");
    slackConfig.slack.maxRetryAfterSeconds = 1; f.slack.rateLimitOnce = true; f.slack.retryAfter = "2";
    await assert.rejects(postMessage({ channel: "C1", text: "too long" }), /rate limited \(retry-after 2\)/);
    slackConfig.slack.maxRetryAfterSeconds = 30; f.slack.retryAfter = "0";
    f.slack.down = true;
    await assert.rejects(postMessage({ channel: "C1", text: "outage" }), /HTTP 503/);
    f.slack.down = false; f.slack.fail = "channel_not_found";
    await assert.rejects(postMessage({ channel: "C9", text: "missing" }), /channel_not_found/);
    f.slack.fail = null;
    await postMessage({ channel: "C1", text: "a".repeat(5000) });
    assert.equal(f.slack.calls.at(-1).body.text.length, 3000);
    assert.equal(escapeSlack("a & <b> c"), "a &amp; &lt;b&gt; c");
    const count = f.slack.calls.length;
    await assert.rejects(postMessage({ channel: "C1", text: "leak " + token }), /credential material/);
    assert.equal(f.slack.calls.length, count);
    delete process.env.SLACK_BOT_TOKEN;
    await assert.rejects(postMessage({ channel: "C1", text: "no token" }), /SLACK_BOT_TOKEN is not set/);
    assert.equal(f.slack.calls.length, count);
  } },
  config_validation: { title: "the configuration schema reports each kind of error once and startup validation rejects every cross-field rule", run: async () => {
    const { validateStaticConfig } = await f.app("startup.ts"), { validateConfig } = await f.app("config-schema.ts"), { config: merged } = await f.app("config.ts");
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    const schema = (change, message) => assert.throws(() => { const copy = structuredClone(merged); change(copy); validateConfig(copy); }, message);
    const startup = (change, message) => assert.rejects(validateStaticConfig(variant(change)), message);
    const publicAnswer = [{ address: "93.184.216.34", family: 4 }];

    validateConfig(merged);
    await validateStaticConfig(f.config);

    schema((c) => { c.harness.maxConcurency = 8; }, /harness\.maxConcurency: unknown setting/);
    schema((c) => { c.harness.maxConcurrentValidations = "3"; }, /harness\.maxConcurrentValidations: must be integer/);
    schema((c) => { c.harness.agentTimeoutSeconds = 1.5; }, /harness\.agentTimeoutSeconds: must be integer/);
    schema((c) => { c.harness = 8; }, /harness: must be object/);
    schema((c) => { c.harness = null; }, /harness: must be object/);
    schema((c) => { c.harness.toString = 1; }, /harness\.toString: unknown setting/);
    schema((c) => { c.harness.maxConcurrentValidations = 0; }, /^Error: Invalid Scrat configuration:\n- harness\.maxConcurrentValidations: must be >= 1$/);
    schema((c) => { c.harness.corrections.incomplete = -1; }, /harness\.corrections\.incomplete: must be >= 0/);
    schema((c) => { c.harness.retryJitter = 2; }, /harness\.retryJitter: must be <= 1/);
    schema((c) => { c.workflows.implement.thinkingLevel = "turbo"; }, /workflows\.implement\.thinkingLevel: must be equal to one of the allowed values/);
    schema((c) => { c.github.auth = "token"; }, /github\.auth: must be equal to one of the allowed values/);
    schema((c) => { c.workspace.commandMemoryMax = "lots"; }, /workspace\.commandMemoryMax: must match pattern/);
    schema((c) => { c.workspace.packageStore = "relative/store"; }, /workspace\.packageStore: must match pattern/);
    schema((c) => { delete c.tools; }, /tools: required/);
    schema((c) => { c.workflows.review_pr.retry = { initialDelaySeconds: 0, maxDelaySeconds: 30 }; }, /workflows\.review_pr\.retry\.initialDelaySeconds: must be >= 1/);
    for (const change of [(c) => { c.workspace.commandMemoryMax = null; }, (c) => { c.workspace.packageStore = null; }, (c) => { c.workflows.review_pr.retry = null; },
      (c) => { c.workflows.address_review.config = { exhaustedLabel: null }; }, (c) => { c.workflows.address_review.config = { exhaustedLabel: "" }; }, (c) => { c.workflows.implement.config = { failedLabel: null }; }, (c) => { c.workspace.environment = { ANY_NEW_KEY: "1" }; }]) {
      const copy = structuredClone(merged); change(copy); validateConfig(copy);
    }

    await startup((c) => { c.workspace.sandbox = false; c.workspace.commandMemoryMax = "6G"; }, /commandMemoryMax requires workspace\.sandbox/);
    await startup((c) => { c.workspace.sandbox = false; c.workspace.packageStore = "/tmp/scrat-store"; }, /packageStore requires workspace\.sandbox/);
    await validateStaticConfig(variant((c) => { c.workspace.commandMemoryMax = null; c.workspace.packageStore = null; }));
    await startup((c) => { c.tools.readBytes.max = c.tools.readBytes.default - 1; }, /tools\.readBytes\.max must not be less than tools\.readBytes\.default/);
    await startup((c) => { c.workspace.heavyCommands = ["^(unclosed"]; }, /heavyCommands\[0\] is not a valid regular expression/);
    await startup((c) => { c.relevance.ignoredPaths = ["^assets/", "^(unclosed"]; }, /relevance\.ignoredPaths\[1\] is not a valid regular expression/);
    await startup((c) => { c.workspace.validate = []; }, /workspace\.validate is empty but address_pr_feedback, address_review, implement, resolve_conflicts publish commits.*\[\["true"\]\]/);
    await validateStaticConfig(variant((c) => { c.workspace.validate = []; for (const name of ["implement", "address_review", "address_pr_feedback", "resolve_conflicts"]) c.workflows[name].enabled = false; }));
    schema((c) => { c.workflows.implement.agent = "panel"; }, /workflows\.implement\.agent: unknown setting/);
    await startup((c) => { c.workflows.review_pr.retry = { initialDelaySeconds: 60, maxDelaySeconds: 30 }; }, /review_pr: retry\.maxDelaySeconds must be at least retry\.initialDelaySeconds/);
    await validateStaticConfig(variant((c) => { c.workflows.review_pr.retry = { initialDelaySeconds: 5, maxDelaySeconds: 5 }; }));
    await startup((c) => { c.workflows.implement.retry = { initialDelaySeconds: 1, maxDelaySeconds: 2 }; }, /implement: retry requires mode review/);
    await startup((c) => { c.workflows.review_pr.config = { failedLabel: "Scrat failed" }; }, /review_pr: failedLabel requires mode change/);
    await startup((c) => { c.workflows.review_issue.model = "missing-model"; }, /review_issue: no Pi model fixture\/missing-model/);
    await startup((c) => { c.workflows.review_pr.reviewers[0].provider = "nowhere"; }, /review_pr reviewer 1: no Pi model nowhere/);
    await startup((c) => { c.workflows.resolve_conflicts.skill = "missing/SKILL.md"; }, /resolve_conflicts: skill file not found/);

    await startup((c) => { c.github.botLogin = " "; }, /github\.botLogin must not be empty/);
    await startup((c) => { c.github.botName = " !! "; }, /github\.botName must contain a letter or digit/);
    await startup((c) => { c.storefront.enabled = true; c.storefront.loggie.slug = " "; c.storefront.loggie.url = "app.loggie.ai"; c.storefront.preview.themePaths = "^(unclosed"; },
      /storefront\.enabled is true but LOGGIE_API_KEY is not set\n- storefront\.enabled requires workspace\.sandbox\n- storefront\.store must not be empty when storefront\.enabled is true\n- storefront\.publicHost must not be empty when storefront\.enabled is true\n- storefront\.loggie\.slug must not be empty when storefront\.enabled is true\n- storefront\.loggie\.url must be an absolute URL\n- storefront\.preview\.themePaths is not a valid regular expression/);
    schema((c) => { c.storefront.preview.uploadBatch = 51; }, /storefront\.preview\.uploadBatch: must be <= 50/);
    await startup((c) => { c.storefront.enabled = true; c.storefront.publicHost = "https://shop.example.com"; }, /storefront\.publicHost must be a host name, without a scheme or path/);
    if (!await import("playwright-core").then(() => true, () => false)) await startup((c) => { c.storefront.enabled = true; }, /storefront_discover: The browser tool needs the optional playwright-core package/);
    schema((c) => { c.storefront.model.thinkingLevel = "turbo"; }, /storefront\.model\.thinkingLevel: must be equal to one of the allowed values/);
    await startup((c) => { c.storefront.enabled = true; c.storefront.model.model = "nope"; }, /storefront\.model: no Pi model fixture\/nope/);
    schema((c) => { c.storefront.limits.browserSeconds = 0; }, /storefront\.limits\.browserSeconds: must be >= 1/);
    schema((c) => { c.storefront.siteMapMaxAgeDays = 1.5; }, /storefront\.siteMapMaxAgeDays: must be integer/);
    schema((c) => { c.storefront.limits.regressionMaxGrade = "C+"; }, /storefront\.limits\.regressionMaxGrade: must be equal to one of the allowed values/);
    await startup((c) => { c.storefront.enabled = true; c.storefront.devices = ["desktop", "tablet"]; }, /storefront\.devices: tablet is not a tools\.browser\.viewports preset/);
    for (const pages of [["home"], ["//other.example.net/"]]) schema((c) => { c.storefront.lighthouse.pages = pages; }, /storefront\.lighthouse\.pages\.0: must match pattern/);
    schema((c) => { c.storefront.lighthouse.timeoutSeconds = 0; }, /storefront\.lighthouse\.timeoutSeconds: must be >= 1/);
    if (!await import("lighthouse").then(() => true, () => false)) {
      await startup((c) => { c.storefront.enabled = true; Object.assign(c.workflows.review_base_change, { enabled: true, config: { ...c.workflows.review_base_change.config, channel: "C0123456789" } }); }, /review_base_change: storefront: Storefront Lighthouse runs need the optional lighthouse package, which is not installed/);
    }
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    await assert.rejects(validateStaticConfig(f.config), /github\.auth is "app" but GITHUB_APP_PRIVATE_KEY is not set/);
    await startup((c) => { c.github.auth = "pat"; }, /github\.auth is "pat" but GITHUB_PAT is not set/);
    process.env.GITHUB_PAT = "ghp_x"; await validateStaticConfig(variant((c) => { c.github.auth = "pat"; })); delete process.env.GITHUB_PAT;
    process.env.GITHUB_APP_PRIVATE_KEY = key;

    const token = ["xoxb", "1111", "2222", "fixturetoken"].join("-");
    const status = (change) => variant((c) => { c.slack = { enabled: true, channel: "C0123456789" }; change(c.slack); });
    const enabled = (change = () => {}) => variant((c) => {
      Object.assign(c.workflows.review_base_change, { enabled: true, config: { ...c.workflows.review_base_change.config, channel: "C0123456789" } }); change(c.workflows.review_base_change);
    });
    delete process.env.SLACK_BOT_TOKEN;
    await assert.rejects(validateStaticConfig(status(() => {})), /SLACK_BOT_TOKEN is not set/);
    await assert.rejects(validateStaticConfig(enabled()), /review_base_change: SLACK_BOT_TOKEN is not set/);
    process.env.SLACK_BOT_TOKEN = token;
    await assert.rejects(validateStaticConfig(status((slack) => { slack.channel = " "; })), /slack\.channel must not be empty/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.config.channel = " "; })), /review_base_change: channel must not be empty/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.branch = " "; })), /branch must not be empty/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.config.startMessage = "{{bot}} saw {{commit}}"; })), /unknown startMessage variable \{\{commit\}\}/);
    await startup((c) => { c.workflows.review_pr.reviewers.pop(); }, /review_pr: reviewers must specify exactly two reviewers/);
    f.slack.fail = "invalid_auth";
    await assert.rejects(validateStaticConfig(status(() => {})), /slack: auth\.test failed: .*invalid_auth/);
    await assert.rejects(validateStaticConfig(enabled()), /review_base_change: Slack auth\.test failed: .*invalid_auth/);
    f.slack.fail = null;

    const secret = "scout-" + "k9Xq2LmPz7".repeat(3);
    process.env.SCOUT_TOKEN = secret;
    const binding = () => ({ secret: "${SCOUT_TOKEN}", hosts: ["api.example.test", "other.example.test"], header: "Authorization", prefix: "Bearer " });
    const bound = (change) => { const copy = structuredClone(f.config); copy.bindings = { scout: binding() }; change(copy.bindings); return { ...copy, resolve: async () => publicAnswer }; };
    const binds = (change, message) => assert.rejects(validateStaticConfig(bound(change)), message);
    await validateStaticConfig(bound(() => {}));
    await binds((b) => { b.scout.secret = "${MISSING_SCOUT_VAR}"; }, /bindings\.scout: \$\{MISSING_SCOUT_VAR\} is not set in the environment/);
    await binds((b) => { b.scout.secret = "literal-secret-value"; }, /bindings\.scout: secret must be a "\$\{VAR\}" placeholder/);
    await binds((b) => { b.scout.hosts = []; }, /bindings\.scout: hosts must be a non-empty list/);
    await binds((b) => { delete b.scout.hosts; }, /bindings\.scout: hosts must be a non-empty list/);
    for (const [host, why] of [["10.0.0.1", "IP address"], ["[::1]", "IP address"], ["::1", "IP address"], ["localhost", "local or metadata"], ["metadata.google.internal", "local or metadata"],
      ["db.internal", "local or metadata"], ["*.example.test", "exact public hostname"], ["example", "exact public hostname"], ["Api.Example.test", "exact public hostname"], ["0x7f.1", "exact public hostname"]]) {
      await binds((b) => { b.scout.hosts = ["api.example.test", host]; }, new RegExp(`bindings\\.scout: hosts: .*${why}`));
    }
    for (const address of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "::ffff:192.168.0.1"]) {
      await assert.rejects(validateStaticConfig({ ...bound(() => {}), resolve: async (host) => host === "other.example.test" ? [{ address, family: address.includes(":") ? 6 : 4 }] : publicAnswer }),
        new RegExp(`bindings\\.scout: hosts: other\\.example\\.test resolves to private address ${address.replace(/\./g, "\\.")}`));
    }
    await binds((b) => { b.scout.header = "Host"; }, /bindings\.scout: header must be a permitted header name/);
    await binds((b) => { b.scout.header = "Bad Header"; }, /header must be a permitted header name/);
    await binds((b) => { b.scout.prefix = "Bearer \nX: y"; }, /prefix must be a single-line string/);
    await binds((b) => { b.scout.extra = 1; }, /bindings\.scout: unknown key extra/);
    await binds((b) => { b.Bad_Name = binding(); }, /bindings\.Bad_Name: name must be lowercase/);
    await binds((b) => { b.scout = "text"; }, /bindings\.scout: must be an object/);
    await validateStaticConfig(bound((b) => { b.scout.header = "X-Api-Key"; delete b.scout.prefix; }));
  } },
  slack_startup: { title: "an enabled Slack action or status config verifies the token with auth.test, while a disabled one makes no Slack call and queued tasks for it are rejected", run: async () => {
    const { validateStaticConfig } = await f.app("startup.ts");
    const token = ["xoxb", "1111", "2222", "fixturetoken"].join("-");
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    const enabled = (change = () => {}) => variant((c) => {
      Object.assign(c.workflows.review_base_change, { enabled: true, config: { ...c.workflows.review_base_change.config, channel: "C0123456789" } }); change(c.workflows.review_base_change);
    });
    await validateStaticConfig(f.config);
    assert.equal(f.slack.calls.length, 0);
    process.env.SLACK_BOT_TOKEN = token;
    await validateStaticConfig(variant((c) => { c.slack = { enabled: true, channel: "C0123456789" }; }));
    assert.deepEqual(f.slack.calls.map((call) => call.method), ["auth.test"]);
    f.slack.calls.length = 0;
    await validateStaticConfig(enabled());
    assert.deepEqual(f.slack.calls.map((call) => call.method), ["auth.test"]);
    delete process.env.SLACK_BOT_TOKEN;
    const calls = f.slack.calls.length;
    await validateStaticConfig(variant((c) => { c.workflows.review_base_change.config = { channel: "", startMessage: "{{nope}}" }; }));
    assert.equal(f.slack.calls.length, calls);
    const { config: live, isWorkflowEnabled } = await f.app("config.ts");
    assert.equal(isWorkflowEnabled("review_base_change"), false);
    assert.equal(isWorkflowEnabled("review_issue"), true);
    f.addIssue(1); f.enqueue(1, "review_base_change"); f.addIssue(2); f.enqueue(2);
    assert.equal(tasks.claimTask().task.subjectId, "issue-2");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1); assert.equal(rejected[0].data.reason, "Workflow review_base_change is disabled");
    assert.equal(f.row(s.tasks, rejected[0].taskId).status, "failed");
    live.workflows.review_base_change.enabled = true;
    f.addIssue(3); f.enqueue(3, "review_base_change");
    assert.equal(tasks.claimTask().task.action, "review_base_change");
    assert.equal(f.slack.calls.length, calls);
  } },
  slack_redaction: { title: "the Slack token never reaches child environments, is caught as a secret, redacted from errors and absent from the journal", run: async () => {
    const token = ["xoxb", "1234567890", "abcdefABCDEF"].join("-"), appToken = ["xoxp", "9876", "zzzz", "fixture", "secondary", "token"].join("-");
    process.env.SLACK_BOT_TOKEN = token;
    const { childEnvironment, containsSecret } = await f.app("secrets.ts"), { redactSecrets, describeError } = await f.app("errors.ts");
    const { postMessage } = await f.app("slack.ts"), { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    assert.equal("SLACK_BOT_TOKEN" in childEnvironment(), false);
    assert.equal(Object.values(childEnvironment()).some((value) => value.includes(token)), false);
    assert.equal(containsSecret("token " + token), true);
    delete process.env.SLACK_BOT_TOKEN;
    assert.equal(containsSecret("token " + token), true); assert.equal(containsSecret(appToken), true);
    for (const benign of ["the xoxb-123 token", "foo-xoxb-1", "xoxbox", "a xox-like word"]) {
      assert.equal(containsSecret(benign), false); assert.equal(redactSecrets(benign), benign);
    }
    process.env.SLACK_BOT_TOKEN = token;
    assert.ok(!redactSecrets(`failed with ${token} and ${appToken}`).includes("xox"));
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(data); return data.length; } return write(fd, data, ...rest); };
    try {
      await postMessage({ channel: "C1", text: "journal check" });
      f.slack.fail = "invalid_auth";
      await assert.rejects(postMessage({ channel: "C1", text: "journal failure" }), /invalid_auth/);
      await assert.rejects(postMessage({ channel: "C1", text: "leak " + token }), /credential material/);
    } finally { fs.writeSync = write; }
    assert.ok(lines.some((line) => line.includes("slack.post_message")));
    assert.ok(!lines.join("").includes(token)); assert.ok(!JSON.stringify(all(s.events)).includes(token));
    assert.ok(!JSON.stringify(describeError(new Error("boom " + token))).includes(token));
  } },
  slack_status: { title: "status threads post nothing while disabled, then one root per issue with replies in order, survive a restart, link the opened PR in the issue thread, retry a 429 and never change a task outcome when Slack is down", run: async () => {
    const channel = "C0123456789";
    const posts = () => f.slack.calls.filter((call) => call.method === "chat.postMessage" && call.body.text !== undefined);
    const roots = () => posts().filter((call) => call.body.thread_ts === undefined);
    const until = async (condition) => { for (let n = 0; n < 400 && !condition(); n++) await new Promise((done) => setTimeout(done, 50)); assert.ok(condition(), "timed out waiting for Slack"); };
    const { config } = await f.app("config.ts");
    await implement(1);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(f.slack.calls.length, 0);

    config.slack.enabled = true; config.slack.channel = channel;
    await implement(2);
    await until(() => posts().some((call) => /^Completed/.test(call.body.text)));
    assert.equal(roots().length, 1); assert.equal(all(s.slackThreads).length, 1);
    const [root, ...replies] = posts(), ts = "1700000000.000001";
    assert.match(root.body.text, /^\*Issue #2\*: <https:\/\/github\.com\/fixture\/project\/issues\/2\|Issue 2>$/);
    assert.equal(root.body.channel, channel); assert.equal(all(s.slackThreads)[0].ts, ts);
    assert.ok(replies.length >= 3); assert.ok(replies.every((call) => call.body.thread_ts === ts && call.body.channel === channel));
    assert.match(replies[0].body.text, /^Started implement/);
    const linked = replies.findIndex((call) => call.body.text.includes("<https://github.com/fixture/project/pull/202|pull request #202>"));
    assert.ok(linked > 0 && linked < replies.length - 1, "the PR link is posted after the start and before completion");
    assert.ok(replies.some((call) => /^Pushed <https:\/\/github\.com\/fixture\/project\/commit\/[0-9a-f]{40}\|[0-9a-f]{7}>$/.test(call.body.text)));
    assert.match(replies.at(-1).body.text, /^Completed/);
    assert.ok(!posts().some((call) => /enqueued|coalesced|Workspace/i.test(call.body.text)));

    const restarted = await import(pathToFileURL(resolve("app/src/slack-status.ts")).href + "?restart");
    let count = posts().length;
    restarted.queueStatus({ subjectId: "issue-2", type: "run.completed", data: { stage: "after restart" } });
    await until(() => posts().length === count + 1);
    assert.equal(roots().length, 1); assert.equal(posts().at(-1).body.thread_ts, ts); assert.equal(posts().at(-1).body.text, "Completed at stage after restart");

    count = f.slack.calls.length; f.slack.rateLimitOnce = true;
    restarted.queueStatus({ subjectId: "issue-2", type: "run.completed", data: { stage: "after limit" } });
    await until(() => f.slack.calls.length === count + 2 && posts().at(-1).body.text === "Completed at stage after limit");
    assert.equal(f.slack.calls.length, count + 2);

    config.slack.channel = "C9999999999";
    restarted.queueStatus({ subjectId: "issue-2", type: "run.completed", data: { stage: "moved" } });
    await until(() => posts().at(-1).body.text === "Completed at stage moved");
    assert.equal(roots().length, 2); assert.equal(roots().at(-1).body.channel, "C9999999999");
    assert.equal(all(s.slackThreads).length, 1); assert.equal(posts().at(-1).body.thread_ts, all(s.slackThreads)[0].ts);
    assert.equal(posts().at(-1).body.channel, "C9999999999");
    config.slack.channel = channel;

    await route(); while (await f.runNextTask());
    await until(() => roots().some((call) => /^\*Pull request #202\*: /.test(call.body.text)));

    f.slack.down = true; const attempted = f.slack.calls.length; f.addIssue(3, ["scrat"]); f.enqueue(3, "implement");
    const outage = await success();
    assert.equal(outage.publication.pullRequestNumber, 203); assert.equal(f.row(s.tasks, outage.taskId).status, "completed");
    await until(() => f.slack.calls.length > attempted);
    assert.equal(all(s.slackThreads).filter((thread) => thread.subjectId === "issue-3").length, 0);
    f.slack.down = false;
    restarted.queueStatus({ subjectId: "issue-3", type: "run.completed", data: { stage: "recovered" } });
    await until(() => posts().some((call) => call.body.text === "Completed at stage recovered"));
    assert.equal(all(s.slackThreads).filter((thread) => thread.subjectId === "issue-3").length, 1);
    assert.ok(roots().some((call) => call.body.text.startsWith("*Issue #3*")));
    for (let seen = -1; seen !== f.slack.calls.length;) { seen = f.slack.calls.length; await new Promise((done) => setTimeout(done, 200)); }
  } },
  commits_source: { title: "the base-branch commit source seeds silently, enqueues one range task per push, survives force-pushes and replays, and stops when disabled", configure: [configureCommitSource], run: async () => {
    const { pollCommits } = await f.app("commit-source.ts");
    const { config: live } = await f.app("config.ts");
    const seed = resolve("seed"), remote = resolve("remote.git");
    const cursor = () => all(s.sourceCursors).map((row) => row.sha);
    const reviews = () => all(s.tasks).filter((t) => t.action === "review_base_change");
    const tip = () => git(remote, "rev-parse", "main");
    const forcePush = () => git(seed, "push", "--force", remote, "main");
    const initial = tip();
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), [initial]); assert.equal(reviews().length, 0);
    assert.equal(all(s.items).length, 0); assert.equal(all(s.subjects).length, 0);
    changeMain("src/one.ts", "export const one = 1;\n");
    assert.equal(await pollCommits(), 1);
    const first = tip(), [task] = reviews();
    assert.deepEqual(task.input, { source: "github_commits", kind: "commit", triggerKey: first, sha: first, previousSha: initial, branch: "main", commitCount: 1, truncated: false });
    assert.equal(task.reason, "main moved to " + first.slice(0, 7)); assert.equal(task.status, "queued"); assert.equal(task.priority, 110);
    const subject = f.row(s.subjects, task.subjectId);
    assert.equal(subject.kind, "commit"); assert.equal(subject.state, "open"); assert.equal(subject.repository, "fixture/project"); assert.equal(subject.workspaceId, null);
    assert.equal(subject.key, "main:" + first); assert.equal(all(s.items).length, 0);
    assert.deepEqual(subject.metadata, { title: "Change src/one.ts", author: "Fixture", url: `https://github.com/fixture/project/commit/${first}` });
    assert.deepEqual(cursor(), [first]);
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 1);
    changeMain("src/two.ts", "export const two = 1;\n"); changeMain("src/three.ts", "export const three = 1;\n");
    assert.equal(await pollCommits(), 1);
    const second = tip(), ranged = reviews().find((t) => t.input.sha === second);
    assert.deepEqual(ranged.input, { source: "github_commits", kind: "commit", triggerKey: second, sha: second, previousSha: first, branch: "main", commitCount: 2, truncated: false });
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 2);
    git(seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--amend", "-m", "Rewritten"); forcePush();
    const rewritten = tip(), parent = git(seed, "rev-parse", "HEAD~1");
    assert.notEqual(rewritten, second);
    assert.equal(await pollCommits(), 1);
    assert.deepEqual(reviews().find((t) => t.input.sha === rewritten).input, { source: "github_commits", kind: "commit", triggerKey: rewritten, sha: rewritten, previousSha: parent, branch: "main", commitCount: 1, truncated: false });
    assert.deepEqual(cursor(), [rewritten]);
    git(seed, "reset", "--hard", "HEAD~1"); forcePush();
    assert.equal(tip(), parent);
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 3); assert.deepEqual(cursor(), [parent]);
    changeMain("src/four.ts", "export const four = 1;\n");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().length, 4);
    const last = tip();
    db.update(s.sourceCursors).set({ sha: initial }).run();
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 4); assert.deepEqual(cursor(), [last]);
    const before = JSON.stringify(all(s.subjects).filter((row) => row.kind === "commit"));
    f.calls.length = 0; await route();
    assert.ok(f.calls.length > 0); assert.ok(!f.calls.some((call) => /\/(issues|pulls)\/0(\/|\?|$)/.test(call.path)), JSON.stringify(f.calls));
    assert.equal(JSON.stringify(all(s.subjects).filter((row) => row.kind === "commit")), before);
    assert.equal(reviews().length, 4); assert.equal(all(s.tasks).length, 4);
    live.workflows.review_base_change.enabled = false;
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), []);
    changeMain("src/five.ts", "export const five = 1;\n");
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), []); assert.equal(reviews().length, 4);
    live.workflows.review_base_change.enabled = true;
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), [tip()]); assert.equal(reviews().length, 4);
    assert.equal(db.select().from(s.sourceCursors).where(eq(s.sourceCursors.branch, "main")).all().length, 1);
    live.workflows.review_base_change.config.maxRangeCommits = 1; const beforeCap = tip();
    changeMain("src/six.ts", "export const six = 1;\n"); changeMain("src/seven.ts", "export const seven = 1;\n");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().length, 5);
    const capped = tip();
    assert.deepEqual(reviews().find((t) => t.input.sha === capped).input, { source: "github_commits", kind: "commit", triggerKey: capped, sha: capped, previousSha: beforeCap, branch: "main", commitCount: 2, truncated: true });
    assert.deepEqual(cursor(), [capped]);
    db.update(s.sourceCursors).set({ sha: "0".repeat(40) }).run();
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 5); assert.deepEqual(cursor(), [capped]);
    changeMain("src/eight.ts", "export const eight = 1;\n");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().length, 6);
  } },
  commits_source_modes: { title: "the commit source enqueues one task per matching commit oldest first with a cap, applies author and message filters in both modes, polls a second branch with its own cursor and rejects only identical trigger filters", configure: [configureCommitSource], run: async () => {
    const { pollCommits } = await f.app("commit-source.ts");
    const { workflows } = await f.app("workflow-registry.ts");
    const { findTriggerConflicts } = await f.app("manifests.ts");
    const { readWorkflows } = await f.app("workflows.ts");
    const { config: live } = await f.app("config.ts");
    const seed = resolve("seed"), remote = resolve("remote.git");
    const base = workflows.find((w) => w.name === "review_base_change"), trigger = base.on.event;
    const authored = (name, file, message, branch = "main") => {
      writeFileSync(resolve(seed, "src", file), "export const " + file.replace(".ts", "") + " = 1;\n"); git(seed, "add", ".");
      git(seed, "-c", "user.name=" + name, "-c", "user.email=" + name + "@users.noreply.github.com", "commit", "-m", message); git(seed, "push", remote, branch);
      return git(remote, "rev-parse", branch);
    };
    const reviews = (action = "review_base_change") => all(s.tasks).filter((t) => t.action === action);
    const shas = (action) => reviews(action).map((t) => t.input.sha);
    const cursor = (branch = "main") => all(s.sourceCursors).find((row) => row.branch === branch)?.sha;
    const parentOf = (sha) => git(remote, "rev-parse", sha + "~1");
    const input = (sha, previousSha, commitCount, truncated, branch = "main") => ({ source: "github_commits", kind: "commit", triggerKey: sha, sha, previousSha, branch, commitCount, truncated });
    assert.equal(await pollCommits(), 0);
    trigger.granularity = "commit";
    const [c1, c2, c3] = ["a1", "a2", "a3"].map((name) => authored("carol", name + ".ts", "Add " + name));
    assert.equal(await pollCommits(), 3);
    assert.deepEqual(shas(), [c1, c2, c3]);
    assert.deepEqual(reviews().map((t) => t.input), [input(c1, parentOf(c1), 1, false), input(c2, c1, 1, false), input(c3, c2, 1, false)]);
    assert.deepEqual(all(s.subjects).filter((row) => row.kind === "commit").map((row) => row.key), ["main:" + c1, "main:" + c2, "main:" + c3]);
    assert.deepEqual(f.row(s.subjects, reviews()[1].subjectId).metadata, { title: "Add a2", author: "carol", url: `https://github.com/fixture/project/commit/${c2}` });
    assert.equal(cursor(), c3); assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 3);
    live.workflows.review_base_change.config.maxRangeCommits = 2;
    const [c4, c5, c6] = ["b1", "b2", "b3"].map((name) => authored("carol", name + ".ts", "Add " + name));
    assert.equal(await pollCommits(), 2);
    assert.deepEqual(reviews().slice(3).map((t) => t.input), [input(c4, c3, 1, false), input(c5, c4, 1, false)]);
    assert.equal(cursor(), c5); assert.equal(await pollCommits(), 1); assert.deepEqual(reviews().slice(5).map((t) => t.input), [input(c6, c5, 1, false)]);
    assert.equal(cursor(), c6); assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 6);
    live.workflows.review_base_change.config.maxRangeCommits = 50;
    trigger.author = "alice";
    const [, d2, , d4] = [authored("bob", "d1.ts", "Bob one"), authored("Alice", "d2.ts", "Alice one"), authored("bob", "d3.ts", "Bob two"), authored("alice", "d4.ts", "Alice two")];
    assert.equal(await pollCommits(), 2); assert.deepEqual(shas().slice(6), [d2, d4]);
    assert.deepEqual(reviews().slice(6).map((t) => t.input.previousSha), [parentOf(d2), parentOf(d4)]);
    trigger.author = "bot";
    authored("bob", "e1.ts", "Bob three"); const e2 = authored(live.github.botLogin, "e2.ts", "Bot one");
    assert.equal(await pollCommits(), 1); assert.equal(shas().at(-1), e2);
    delete trigger.author; trigger.message = "[review]";
    authored("bob", "f1.ts", "Plain change"); const f2 = authored("bob", "f2.ts", "Fix it [review]\n\nbody"); authored("bob", "f3.ts", "Review without brackets");
    assert.equal(await pollCommits(), 1); assert.equal(shas().at(-1), f2);
    trigger.author = "carol"; authored("bob", "g1.ts", "Also [review]");
    const g2 = authored("carol", "g2.ts", "Carol [review]"); authored("carol", "g3.ts", "Carol plain");
    assert.equal(await pollCommits(), 1); assert.equal(shas().at(-1), g2);
    const total = reviews().length;
    trigger.granularity = "range"; delete trigger.author; delete trigger.message;
    const h1 = authored("bob", "h1.ts", "Range one"), h2 = authored("bob", "h2.ts", "Range two");
    assert.equal(await pollCommits(), 1);
    assert.deepEqual(reviews().at(-1).input, input(h2, parentOf(h1), 2, false));
    trigger.author = "alice";
    authored("bob", "i1.ts", "Bob only"); const i2 = authored("bob", "i2.ts", "Bob again");
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, total + 1); assert.equal(cursor(), i2);
    const j1 = authored("alice", "j1.ts", "Alice in range"), j2 = authored("bob", "j2.ts", "Bob after");
    assert.equal(await pollCommits(), 1);
    assert.deepEqual(reviews().at(-1).input, input(j2, parentOf(j1), 2, false));
    delete trigger.author; trigger.message = "ship it";
    authored("bob", "k1.ts", "Nothing"); assert.equal(await pollCommits(), 0);
    authored("bob", "k2.ts", "Please ship it now"); const k3 = authored("bob", "k3.ts", "After");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().at(-1).input.sha, k3); assert.equal(reviews().at(-1).input.commitCount, 2);
    delete trigger.message;
    const count = reviews().length;
    git(seed, "switch", "-c", "develop"); const dev0 = authored("dave", "dev0.ts", "Develop start", "develop");
    workflows.push({ ...base, name: "review_develop", file: "workflows/review_develop/workflow.yaml", on: { ...base.on, event: { ...trigger, branch: "develop", granularity: "commit" } } });
    live.workflows.review_develop = { ...live.workflows.review_base_change, branch: "develop" };
    assert.equal(await pollCommits(), 0); assert.equal(cursor("develop"), dev0);
    const dev1 = authored("dave", "dev1.ts", "Develop one", "develop"), dev2 = authored("dave", "dev2.ts", "Develop two", "develop");
    assert.equal(await pollCommits(), 2);
    assert.deepEqual(reviews("review_develop").map((t) => t.input), [input(dev1, dev0, 1, false, "develop"), input(dev2, dev1, 1, false, "develop")]);
    assert.ok(all(s.subjects).some((row) => row.key === "develop:" + dev2));
    assert.equal(reviews().length, count); assert.equal(all(s.sourceCursors).length, 2);
    assert.equal(cursor("main"), k3); assert.equal(cursor("develop"), dev2);
    assert.equal(await pollCommits(), 0);
    const identical = [{ file: "one.yaml", trigger: base.on.event }, { file: "two.yaml", trigger: base.on.event }];
    assert.match(findTriggerConflicts(identical, () => true)[0], /one\.yaml and two\.yaml both match \{source: github_commits, kind: commit, branch: main\}/);
    const pair = (first, second) => findTriggerConflicts([{ file: "one.yaml", trigger: { ...base.on.event, ...first } }, { file: "two.yaml", trigger: { ...base.on.event, ...second } }], () => true);
    assert.deepEqual(pair({ author: "alice" }, {}), []);
    assert.deepEqual(pair({ author: "alice" }, { author: "bob" }), []);
    assert.deepEqual(pair({ message: "a" }, { message: "b" }), []);
    assert.equal(pair({ author: "alice", message: "a" }, { author: "alice", message: "a" }).length, 1);
    assert.deepEqual(findTriggerConflicts(identical, (m) => m.file === "one.yaml"), []);
    let loaded = 0;
    const mutate = (name, change, message) => {
      const root = resolve("modes-" + ++loaded); mkdirSync(root);
      cpSync(resolve("app/workflows"), resolve(root, "workflows"), { recursive: true });
      const path = resolve(root, "workflows", name, "workflow.yaml");
      writeFileSync(path, change(readFileSync(path, "utf8")));
      if (message) assert.throws(() => readWorkflows(root), message); else readWorkflows(root);
    };
    const extend = (lines) => (text) => text.replace(/^  event:\n/m, `  event:\n${lines.map((line) => `    ${line}`).join("\n")}\n`);
    mutate("review_base_change", extend(["granularity: commit", "author: alice", "message: ship it"]));
    mutate("review_base_change", extend(["author: bot"]));
    mutate("address_review", (text) => text.replace(/^  maxSelfRepairs: .*\n/m, ""), /kind low_grade requires config\.maxSelfRepairs/);
    mutate("review_base_change", (text) => text.replace(/^  maxRangeCommits: .*\n/m, ""), /source github_commits requires config\.maxRangeCommits/);
    mutate("review_base_change", extend(["granularity: sometimes"]), /granularity/);
    mutate("review_base_change", extend(['message: ""']), /message/);
    mutate("review_issue", extend(["message: x"]), /on\.event\.message and on\.event\.granularity are only allowed with source github_commits/);
    mutate("review_issue", extend(["granularity: commit"]), /on\.event\.message and on\.event\.granularity are only allowed/);
    mutate("review_issue", extend(["author: alice"]), /on\.event\.author must be "bot" for github_items/);
    mutate("review_issue", extend(["author: bot"]));
  } },
  commit_review_e2e: { title: "a push to the base branch posts one templated root, runs one diff-only review, replies once in the thread and reacts on the root with the verdict, without any GitHub write", configure: [configureCommitSource], run: () => commitReview("e2e") },
  commit_review_no_start: { title: "a commit manifest without a start slot posts no thread root before the agent and the reply creates the root", configure: [configureCommitSource, configureNoStart], run: () => commitReview("no_start") },
  commit_review_panel: { title: "a panel commit review runs two reviewers and a consolidator without requiring a grade and replies once", configure: [configureCommitSource, configureCommitPanel], run: () => commitReview("panel") },
  commit_review_slack_down: { title: "a failed root post still reviews and the reply creates the root, while a failed reply fails at publishing and retries without a new session or second root", configure: [configureCommitSource], run: () => commitReview("slack_down") },
  commit_review_storefront: { title: "with the storefront enabled, a main change whose theme files match the live MAIN theme gets a browser review of the live store against stored baselines and Lighthouse averages with deltas, posted as its own concise Slack message and a full commit comment edited in place; a new confirmed breakage turns the reaction red once per fingerprint, only a clean run replaces the baselines, the code review keeps its session, a live theme that does not match yet skips with one line, and a disabled storefront changes nothing", seed: seedTheme, configure: [configureCommitSource, configureMainStorefront], run: async () => {
    const { fakes, push, scored, previous, code, codeText, replies, replyBlocks, reactions, sessions, reports, state, link } = await mainStorefront();
    const { config: live } = await f.app("config.ts"), site = "https://shop.example.test", json = (path) => JSON.parse(state(path)), S = storefrontScores;
    const m1 = { "first-contentful-paint": 1.8, "largest-contentful-paint": 3.1, "total-blocking-time": 210, "cumulative-layout-shift": 0.05, "speed-index": 2.9 };
    const breakage = (verdict) => "The variant picker is broken on product pages.\n\n## Checked\n- `/products/tee` on the purchase path.\nSCRAT_ISSUE_BEGIN\ntitle: The variant picker does nothing on mobile\nfingerprint: product:variant-picker\n\nPicked Size M three times after reset; the price and image stayed on Size S.\nSCRAT_ISSUE_END\n"
      + `SCRAT_VERDICT: ${verdict}\nSCRAT_STATUS: complete`;

    scored([S(0.6, 0.9, 0.96, 1), S(0.7, 0.9, 0.96, 1)], [S(0.9, 0.95, 1, 1), S(0.95, 0.95, 1, 1)]);
    const first = await push({ "sections/hero.liquid": "<section>Hero</section>\n", "assets/app.css": "body { color: red; }\n", "README.md": "# Theme v2\n" });
    f.script = [code,
      { name: "browser", args: { action: "goto", url: site + "/" } },
      { name: "browser", args: { action: "screenshot", viewport: "desktop", fullPage: true } },
      { name: "browser", args: { action: "screenshot", viewport: "mobile", fullPage: true } },
      { name: "browser", args: { action: "goto", url: site + "/products/tee?variant=1" } },
      { name: "browser", args: { action: "screenshot", viewport: "desktop", fullPage: true } },
      { name: "browser", args: { action: "reset" } },
      { name: "browser", args: { action: "goto", url: site + "/cart" } },
      "The home page shows the new hero; nothing else changed.\n• `/` desktop and mobile: a hero section sits above the collection grid, as the commit intends.\n\n## Checked\n- `/` because the commit adds `sections/hero.liquid`.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete"];
    const r1 = await success();
    assert.deepEqual(f.loggie.requests.map(({ field, variables }) => [field, variables.filenames]), [["themes", undefined], ["theme", ["assets/app.css", "sections/hero.liquid"]]], "only the changed theme files are compared, and nothing is written");
    const [session] = sessions(), browserTool = session.request.tools.find((tool) => tool.function.name === "browser");
    assert.deepEqual(session.context.storefront, { liveUrl: site + "/", sha: first, previousSha: previous, devices: ["desktop", "mobile"], confirmationRuns: 1, knownBreakages: [] });
    assert.deepEqual(session.context.diffPaths, ["README.md", "assets/app.css", "sections/hero.liquid"]);
    assert.equal(session.request.model, "gpt-6.1-terra"); assert.notEqual(f.requests.find((request) => !request.context.storefront).request.model, "gpt-6.1-terra");
    assert.deepEqual([session.context.files.siteMap, session.context.files.baselines], [undefined, undefined], "the first run has no site map and no baselines");
    assert.deepEqual(session.request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), ["read", "grep", "find", "ls", "git", "browser"]); assert.match(session.text, /# Live storefront review/);
    assert.match(browserTool.function.description, /public https sites.*At most 80 actions and 1200 seconds per session/s);
    assert.ok(f.requests.filter((request) => !request.context.storefront).every((request) => !request.request.tools.some((tool) => tool.function.name === "browser")), "the code review itself gets no browser");
    const { piSessionId, piSessionFile } = f.row(s.runs, r1.id), storefrontSession = r1.result.storefrontReview.session;
    assert.notEqual(storefrontSession.piSessionId, piSessionId);
    assert.match(readFileSync(piSessionFile, "utf8"), /# Base branch change review/, "the run keeps the code review's session");
    assert.match(readFileSync(storefrontSession.piSessionFile, "utf8"), /# Live storefront review/, "the storefront session is recorded beside it");
    assert.match(r1.publication.storefrontReportUrl, new RegExp(`^https://github\\.com/fixture/project/commit/${first}#commitcomment-\\d+$`));
    assert.deepEqual(replies(), [codeText, `*Storefront* on ${first.slice(0, 7)}: The home page shows the new hero; nothing else changed.\n`
      + "• `/` desktop and mobile: a hero section sits above the collection grid, as the commit intends.\n"
      + "• Lighthouse mobile (2 runs, no previous run): Performance 65, Accessibility 90, Best Practices 96, SEO 100; FCP 1.8 s, LCP 3.1 s, TBT 210 ms, CLS 0.05, Speed Index 2.9 s\n"
      + "• Lighthouse desktop (2 runs, no previous run): Performance 93, Accessibility 95, Best Practices 100, SEO 100; FCP 1.8 s, LCP 3.1 s, TBT 210 ms, CLS 0.05, Speed Index 2.9 s" + link(r1)], "the block is its own message after the code review");
    assert.deepEqual(reactions(), ["white_check_mark"]); assert.equal(r1.result.verdict, "clean");
    const [report] = reports(), runs = `data/runs/${r1.id}`;
    assert.equal(report.sha, first); assert.ok(report.body.endsWith("<!-- scrat-storefront -->"));
    for (const text of [`## Storefront review of ${first}\n\nThe live \`MAIN\` theme matches this commit for the 2 theme file(s) the change touches.\n\nThe home page shows the new hero`,
      "## Checked\n- `/` because the commit adds `sections/hero.liquid`.", "| Lighthouse | Mobile | Desktop |\n| --- | --- | --- |\n| Runs | 2 | 2 |\n| Performance | 65 | 93 |\n| Accessibility | 90 | 95 |\n| Best Practices | 96 | 100 |\n| SEO | 100 | 100 |\n| FCP | 1.8 s | 1.8 s |\n| LCP | 3.1 s | 3.1 s |\n| TBT | 210 ms | 210 ms |\n| CLS | 0.05 | 0.05 |\n| Speed Index | 2.9 s | 2.9 s |",
      `| mobile | \`/\` | 1 | 60 | 90 | 96 | 100 | 1.8 s | 3.1 s | 210 ms | 0.05 | 2.9 s | \`${runs}/lighthouse/mobile-1-1.json\` |`, `| desktop | \`/\` | 2 | 95 | 95 | 100 | 100 | 1.8 s | 3.1 s | 210 ms | 0.05 | 2.9 s | \`${runs}/lighthouse/desktop-1-2.json\` |`,
      `3 screenshot(s) under \`${runs}\`:\n- \`${site}/\` at desktop: \`${runs}/screenshot-desktop-1.png\`\n- \`${site}/\` at mobile: \`${runs}/screenshot-mobile-2.png\`\n- \`${site}/products/tee?variant=1\` at desktop: \`${runs}/screenshot-desktop-3.png\``,
      "The baselines under `data/storefront/baselines` are now this run's 3 screenshot(s)."]) assert.ok(report.body.includes(text), text);
    assert.deepEqual([state("baselines/home/desktop.png"), state("baselines/home/mobile.png"), state("baselines/products_tee/desktop.png")], ["png / 1280 v1", "png / 390 v1", "png /products/tee 1280 v1"]);
    assert.deepEqual(json("baselines/index.json"), { home: { url: site + "/", devices: { desktop: first, mobile: first } }, products_tee: { url: site + "/products/tee", devices: { desktop: first } } });
    assert.deepEqual(json("lighthouse.json"), { mobile: { sha: first, scores: S(65, 90, 96, 100), metrics: m1 }, desktop: { sha: first, scores: S(93, 95, 100, 100), metrics: m1 } });
    assert.deepEqual(JSON.parse(readFileSync(`${runs}/lighthouse/mobile-1-1.json`, "utf8")), { url: site + "/", device: "mobile", next: S(0.6, 0.9, 0.96, 1) }, "each run's report is kept as evidence");
    assert.deepEqual(fakes.audits.map(({ url, device, output, categories, screenshot }) => [url, device, output, categories.join(","), screenshot]),
      [...Array(2).fill([site + "/", "mobile", "json", "performance,accessibility,best-practices,seo", false]), ...Array(2).fill([site + "/", "desktop", "json", "performance,accessibility,best-practices,seo", false])]);
    const debugging = fakes.launches.filter((args) => args.length), browsing = fakes.launches.filter((args) => !args.length);
    assert.deepEqual(debugging.map(([flag]) => Number(/^--remote-debugging-port=(\d+)$/.exec(flag)[1])), fakes.audits.map(({ port }) => port), "each Lighthouse run drives its own Chromium through its debugging port");
    assert.deepEqual([...new Set(fakes.launchOptions.map((options) => JSON.stringify(options)))], [JSON.stringify({ headless: true, channel: "chromium", chromiumSandbox: true })], "every launch asks Playwright for the full Chromium build with its sandbox");
    assert.equal(browsing.length, 1, "the storefront browser pins no hosts, and its reset keeps the same Chromium");
    assert.deepEqual(fakes.visits, [site + "/", site + "/products/tee?variant=1", site + "/cart"]);

    mkdirSync("data/storefront", { recursive: true }); writeFileSync("data/storefront/site.md", "Site map\n- `/products/<handle>`: product page\n");
    fakes.look = "v2";
    scored([S(0.62, 0.9, 0.96, 1, [1600, 3500, 240, 0.05, 2800]), S(0.62, 0.9, 0.96, 1, [1600, 3500, 240, 0.05, 2800])]);
    const second = await push({ "sections/hero.liquid": "<section>Hero 2</section>\n" });
    f.script = [code, { name: "browser", args: { action: "goto", url: site + "/" } }, { name: "browser", args: { action: "screenshot", viewport: "desktop", fullPage: true } }, breakage("breaking")];
    const r2 = await success(), secondSession = sessions().at(-1);
    assert.equal(readFileSync(secondSession.context.files.siteMap, "utf8"), "Site map\n- `/products/<handle>`: product page\n");
    const baselines = JSON.parse(readFileSync(secondSession.context.files.baselines, "utf8"));
    assert.deepEqual(Object.keys(baselines.pages), ["home", "products_tee"]); assert.equal(baselines.pages.home.sha, first.slice(0, 7));
    assert.equal(readFileSync(resolve(baselines.baselinesDir, baselines.pages.home.devices.desktop), "utf8"), "png / 1280 v1", "the agent reads the previous run's screenshot from its own context directory");
    assert.equal(replies().at(-1), `*Storefront* on ${second.slice(0, 7)}: The variant picker is broken on product pages.\n• New breakage \`product:variant-picker\`: The variant picker does nothing on mobile\n`
      + "• Lighthouse mobile (2 runs): Performance 62 (-3), Accessibility 90 (±0), Best Practices 96 (±0), SEO 100 (±0); FCP 1.6 s (-0.2), LCP 3.5 s (+0.4), TBT 240 ms (+30), CLS 0.05 (±0.00), Speed Index 2.8 s (-0.1)\n"
      + "• Lighthouse desktop (2 runs): Performance 90 (-3), Accessibility 95 (±0), Best Practices 100 (±0), SEO 100 (±0); FCP 1.8 s (±0.0), LCP 3.1 s (±0.0), TBT 210 ms (±0), CLS 0.05 (±0.00), Speed Index 2.9 s (±0.0)" + link(r2));
    const cell = (text) => ({ type: "raw_text", text }), align = ["left", "right", "right"].map((value) => ({ align: value }));
    assert.deepEqual(replyBlocks().at(-1), [
      { type: "rich_text", elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "Storefront", style: { bold: true } }, { type: "text", text: ` on ${second.slice(0, 7)}: The variant picker is broken on product pages.` }] },
        { type: "rich_text_list", style: "bullet", elements: [{ type: "rich_text_section", elements: [
          { type: "text", text: "New breakage " }, { type: "text", text: "product:variant-picker", style: { code: true } }, { type: "text", text: ": The variant picker does nothing on mobile" }] }] },
      ] },
      { type: "table", column_settings: align, rows: [
        ["Lighthouse", "Mobile", "Desktop"],
        ["Runs", "2", "2"],
        ["Performance", "62 (-3)", "90 (-3)"],
        ["Accessibility", "90 (±0)", "95 (±0)"],
        ["Best Practices", "96 (±0)", "100 (±0)"],
        ["SEO", "100 (±0)", "100 (±0)"],
        ["FCP", "1.6 s (-0.2)", "1.8 s (±0.0)"],
        ["LCP", "3.5 s (+0.4)", "3.1 s (±0.0)"],
        ["TBT", "240 ms (+30)", "210 ms (±0)"],
        ["CLS", "0.05 (±0.00)", "0.05 (±0.00)"],
        ["Speed Index", "2.8 s (-0.1)", "2.9 s (±0.0)"],
      ].map((row) => row.map(cell)) },
      { type: "section", text: { type: "mrkdwn", text: `<${r2.publication.storefrontReportUrl}|Full storefront report>` } },
    ]);
    assert.equal(reactions().at(-1), "large_red_square"); assert.equal(r2.result.verdict, "breaking");
    assert.equal(state("baselines/home/desktop.png"), "png / 1280 v1", "a run with a breakage keeps the baselines");
    assert.deepEqual(json("alerts.json"), { "product:variant-picker": { title: "The variant picker does nothing on mobile", sha: second } });
    for (const text of ["### Confirmed breakage\n\n- **The variant picker does nothing on mobile** (`product:variant-picker`, new on this commit)\n\n  Picked Size M three times after reset", "were kept, because the storefront verdict is breaking"]) assert.ok(reports().at(-1).body.includes(text), text);

    f.slack.rejectBlocks = true;
    scored(undefined, ["Chrome crashed", S(0.92, 0.95, 1, 1)]);
    const third = await push({ "snippets/price.liquid": "<span>price</span>\n" });
    f.script = [code, breakage("breaking")];
    const r3 = await success();
    assert.deepEqual(sessions().at(-1).context.storefront.knownBreakages, [{ fingerprint: "product:variant-picker", title: "The variant picker does nothing on mobile", since: second }]);
    assert.equal(replyBlocks().at(-1), undefined, "a reply whose blocks Slack rejects is posted again as text only"); assert.equal(f.slack.rejectBlocks, false);
    assert.equal(replies().at(-1), `*Storefront* on ${third.slice(0, 7)}: The variant picker is broken on product pages.\n• Still broken since ${second.slice(0, 7)} \`product:variant-picker\`: The variant picker does nothing on mobile\n`
      + "• Lighthouse mobile (2 runs): Performance 60 (-2), Accessibility 90 (±0), Best Practices 96 (±0), SEO 100 (±0); FCP 1.8 s (+0.2), LCP 3.1 s (-0.4), TBT 210 ms (-30), CLS 0.05 (±0.00), Speed Index 2.9 s (+0.1)\n"
      + "• Lighthouse desktop (1 of 2 runs): Performance 92 (+2), Accessibility 95 (±0), Best Practices 100 (±0), SEO 100 (±0); FCP 1.8 s (±0.0), LCP 3.1 s (±0.0), TBT 210 ms (±0), CLS 0.05 (±0.00), Speed Index 2.9 s (±0.0)" + link(r3));
    assert.equal(reactions().at(-1), "large_orange_square", "a breakage already reported raises no new red alert"); assert.equal(r3.result.verdict, "concerns");
    assert.deepEqual(json("alerts.json"), { "product:variant-picker": { title: "The variant picker does nothing on mobile", sha: second } });
    for (const text of [`(\`product:variant-picker\`, first reported on ${second})`, "| desktop | `/` | 1 | - | - | - | - | - | - | - | - | - | Chrome crashed |", "| Runs | 2 | 1 of 2 |", "| Performance | 60 (-2) | 92 (+2) |"]) assert.ok(reports().at(-1).body.includes(text), text);

    scored();
    const fourth = await push({ "snippets/price.liquid": "<span>price 2</span>\n" }), long = "The change is large. " + "x".repeat(3500);
    f.script = [`${long}\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete`, { name: "browser", args: { action: "goto", url: site + "/" } }, { name: "browser", args: { action: "screenshot", viewport: "desktop", fullPage: true } },
      "The variant picker works again.\n\n## Checked\n- `/`.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete"];
    f.slack.reactionFail = ["service_unavailable"];
    const failed = await run(), commented = reports().length, posted = replies().length, used = f.requests.length;
    assert.equal(failed.stage, "publishing"); assert.ok(failed.publication.storefrontReportUrl && failed.publication.storefrontReplyTs && failed.publication.slackReplyTs);
    assert.equal(replies().at(-2).length, 3000, "a long code review is cut on its own"); assert.ok(replies().at(-2).endsWith("…"));
    tasks.retryTask(failed.taskId);
    const r4 = await success();
    assert.deepEqual([reports().length, replies().length, f.requests.length], [commented, posted, used], "a retried publication posts neither the comment nor a message again");
    assert.equal(replies().at(-1), `*Storefront* on ${fourth.slice(0, 7)}: The variant picker works again.\n`
      + "• Lighthouse mobile (2 runs): Performance 60 (±0), Accessibility 90 (±0), Best Practices 96 (±0), SEO 100 (±0); FCP 1.8 s (±0.0), LCP 3.1 s (±0.0), TBT 210 ms (±0), CLS 0.05 (±0.00), Speed Index 2.9 s (±0.0)\n"
      + "• Lighthouse desktop (2 runs): Performance 90 (-2), Accessibility 95 (±0), Best Practices 100 (±0), SEO 100 (±0); FCP 1.8 s (±0.0), LCP 3.1 s (±0.0), TBT 210 ms (±0), CLS 0.05 (±0.00), Speed Index 2.9 s (±0.0)" + link(r4), "the storefront message keeps its link however long the code review is");
    assert.equal(reactions().at(-1), "white_check_mark");
    assert.deepEqual(json("alerts.json"), {}, "a clean run clears the alerts");
    assert.deepEqual(json("baselines/index.json"), { home: { url: site + "/", devices: { desktop: fourth } } }, "a clean run keeps only the pages it captured");
    assert.equal(state("baselines/home/desktop.png"), "png / 1280 v2"); assert.ok(!existsSync("data/storefront/baselines/products_tee"));
    scored();
    f.reset(0, "normal"); f.script = [code, "The store still works.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete"];
    tasks.enqueueTask({ subjectId: f.row(s.tasks, r4.taskId).subjectId, action: "review_base_change", reason: "Review again", input: f.row(s.tasks, r4.taskId).input });
    await success();
    assert.equal(reports().length, commented, "a second review of the same commit edits its storefront comment");
    assert.deepEqual(f.written("commit_comment_update").map(({ body }) => body.includes("The store still works.")), [true]);

    const counts = () => [sessions().length, fakes.audits.length, reports().length];
    const before = counts(), fifth = await push({ "assets/app.css": "body { color: blue; }\n" }, false);
    f.script = [code];
    const logs = captureLogs();
    try { await success(); } finally { restoreLogs(); }
    assert.deepEqual(logs.find((line) => line.event === "storefront.live_mismatch")?.paths, ["assets/app.css"]);
    assert.deepEqual(replies().slice(-2), [codeText, `*Storefront*: the live theme does not match ${fifth.slice(0, 7)} yet (1 of 1 changed theme files differ), so the visual review and Lighthouse were skipped.`]);
    assert.deepEqual(counts(), before, "a live theme that does not match yet gets no browser review, Lighthouse run or commit comment");
    assert.equal(reactions().at(-1), "white_check_mark");

    live.storefront.enabled = false;
    const messages = replies().length;
    await push({ "assets/app.css": "body { color: green; }\n" });
    f.script = [code];
    await success();
    assert.deepEqual(replies().slice(messages), [codeText]); assert.equal(f.loggie.requests.length, 0); assert.deepEqual(counts(), before, "a disabled storefront changes nothing");
  } },
  commit_review_storefront_failures: { title: "the main-branch storefront review handles a change with no theme files, a deleted theme file and a live file whose checksum is not the MD5 of its bytes, reports a Loggie or agent failure without holding back the code review, posts its block without a link when the commit comment is refused, and abandons Lighthouse runs that outlive their budget", seed: seedTheme, configure: [configureCommitSource, configureMainStorefront], run: async () => {
    const { fakes, push, scored, code, codeText, replies, reactions, reports, link } = await mainStorefront();
    const { config: live } = await f.app("config.ts"), main = f.loggie.themes.get(f.loggie.mainTheme), done = "Nothing visible changed.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete";

    scored();
    const docs = await push({ "README.md": "# Theme docs\n" });
    f.script = [code, done];
    await success();
    assert.equal(f.loggie.requests.length, 0, "a change with no theme files needs no live proof");
    assert.ok(reports().at(-1).body.includes(`## Storefront review of ${docs}\n\nThe change touches no theme files; the live store was reviewed as it is.`));

    const deleting = await push({ "templates/index.json": null, "config/settings_data.json": "{\"current\":{\"color\":\"red\"}}\n" }, false);
    f.loggie.setLive({ ...Object.fromEntries([...main.bodies].map(([path, { value }]) => [path, value])), "config/settings_data.json": "{\"current\":{\"color\":\"red\"}}\n" });
    main.files.set("config/settings_data.json", f.loggie.md5("{\"current\":{\"color\":\"red\"}}"));
    f.script = [code];
    const unsynced = await success();
    assert.equal(replies().at(-1), `*Storefront*: the live theme does not match ${deleting.slice(0, 7)} yet (1 of 2 changed theme files differ), so the visual review and Lighthouse were skipped.`, "a file whose checksum Shopify took over its own serialization is compared by its bytes, and a deleted file must be gone");
    main.files.delete("templates/index.json"); main.bodies.delete("templates/index.json");
    scored(); f.reset(0, "normal"); f.script = [code, done];
    tasks.enqueueTask({ subjectId: f.row(s.tasks, unsynced.taskId).subjectId, action: "review_base_change", reason: "Synced", input: f.row(s.tasks, unsynced.taskId).input });
    await success();
    assert.ok(reports().at(-1).body.includes("The live `MAIN` theme matches this commit for the 2 theme file(s) the change touches."));

    f.loggie.restricted.add("theme");
    const refused = await push({ "assets/app.css": "body { color: teal; }\n" });
    f.script = [code];
    await success();
    assert.deepEqual(replies().slice(-2), [codeText, "*Storefront*: not checked (Loggie refused theme with HTTP 403 ENDPOINT_RESTRICTED: theme is not allowed by this profile)."]);
    assert.equal(reactions().at(-1), "white_check_mark", "a Loggie failure still publishes the code review and its reaction"); assert.ok(!reports().some(({ sha }) => sha === refused));
    f.loggie.restricted.clear();

    scored();
    const broken = await push({ "assets/app.css": "body { color: navy; }\n" });
    f.script = [code, "no footer", "no footer", "no footer"];
    const agentFailed = await success();
    assert.match(replies().at(-1), new RegExp(`^\\*Storefront\\* on ${broken.slice(0, 7)}: the visual review failed \\(Pi must end its response with SCRAT_STATUS: complete, incomplete, or needs_decision\\)\\n• Lighthouse mobile \\(2 runs\\)`));
    assert.equal(agentFailed.result.verdict, "clean"); assert.equal(reactions().at(-1), "white_check_mark");
    assert.ok(reports().at(-1).body.includes("were kept, because the visual review did not complete"));

    scored(); f.faults.commitComment.add(await push({ "assets/app.css": "body { color: olive; }\n" }));
    f.script = [code, done];
    const logs = captureLogs();
    let withoutLink;
    try { withoutLink = await success(); } finally { restoreLogs(); }
    assert.equal(logs.find((line) => line.event === "storefront.report_failed")?.err.status, 403);
    assert.equal(withoutLink.publication.storefrontReportUrl, undefined); assert.ok(withoutLink.publication.storefrontReplyTs);
    assert.ok(!replies().at(-1).includes("Full storefront report"), "a refused commit comment never blocks the Slack block"); assert.match(replies().at(-1), /^\*Storefront\* on \w{7}: Nothing visible changed\./);

    live.storefront.lighthouse.timeoutSeconds = 1; fakes.scores.mobile.push("hang");
    await push({ "assets/app.css": "body { color: plum; }\n" });
    f.script = [code, done];
    const started = Date.now(), timed = await success();
    assert.ok(Date.now() - started < 20_000, "a hanging Lighthouse run does not hold the review");
    assert.ok(replies().at(-1).endsWith("• Lighthouse mobile: no result (stopped when the 1s budget was spent)\n• Lighthouse desktop: no result (not run, the 1s budget was spent)" + link(timed)));

    live.harness.drainTimeoutSeconds = 1; scored();
    await push({ "assets/app.css": "body { color: gold; }\n" });
    const stop = new AbortController(), codeRequests = () => f.requests.filter((request) => !request.context.storefront).length, before = replies().length;
    f.script = [code, done]; f.onModel = (context) => { if (context.storefront) stop.abort(); else f.modes.set(0, "stall"); };
    const cut = await f.runNextTask(stop.signal); f.onModel = undefined;
    assert.equal(cut.error.code, "RUN_INTERRUPTED"); assert.equal(cut.stage, "validating"); assert.equal(f.row(s.tasks, cut.taskId).status, "queued");
    const reviewed = codeRequests(); assert.equal(replies().length, before);
    f.reset(0, "normal"); f.script = [done];
    const resumed = await success();
    assert.equal(resumed.retryOfRunId, cut.id); assert.equal(resumed.inferenceFromRunId, cut.id); assert.equal(codeRequests(), reviewed, "the code review is not re-prompted");
    assert.equal(resumed.result.text, cut.result.text); assert.equal(replies().length, before + 2, "the code review and the storefront block are each posted once");
    assert.equal(replies().at(-2), codeText); assert.match(replies().at(-1), /^\*Storefront\* on \w{7}: Nothing visible changed\./);
    assert.ok(all(s.events).some((event) => event.type === "run.resumed" && event.runId === resumed.id && event.data.fromRunId === cut.id && event.data.reason === "drain"));
  } },
  manifests: { title: "every workflow is loaded from a validated bundle, malformed workflows are rejected with file and path, and local overrides reach the runtime", run: async () => {
    const { readWorkflows } = await f.app("workflows.ts");
    const { config: live, isWorkflowEnabled } = await f.app("config.ts");
    let count = 0;
    const broken = (name, change, message) => {
      const root = resolve("broken-" + ++count); mkdirSync(root);
      cpSync(resolve("app/workflows"), resolve(root, "workflows"), { recursive: true });
      const path = resolve(root, "workflows", name, "workflow.yaml");
      writeFileSync(path, change(readFileSync(path, "utf8")));
      assert.throws(() => readWorkflows(root), message);
    };
    broken("review_pr", (text) => text + "bogus: 1\n", /workflows\/review_pr\/workflow\.yaml: \/bogus: unknown key/);
    broken("review_issue", (text) => withTools(text, "[read, teleport]"), /workflows\/review_issue\/workflow\.yaml: \/defaults\/tools\/1/);
    broken("review_issue", (text) => text.replace("name: review_issue", "name: Review-Issue"), /workflows\/review_issue\/workflow\.yaml: \/name/);
    broken("review_issue", (text) => withTools(text, "[read, bash]"), /mode review forbids the bash, edit and write tools/);
    f.addIssue(1); f.enqueue(1);
    assert.equal(isWorkflowEnabled("review_issue"), true); assert.equal(isWorkflowEnabled("nope"), false);
    assert.equal(live.workflows.review_pr.provider, "fixture"); assert.equal(live.workflows.review_pr.reviewers[1].provider, "fixture");
    const claimed = tasks.claimTask();
    assert.equal(claimed.run.provider, "fixture"); assert.equal(claimed.run.model, "gpt-6.2-sol");
  } },
  manifest_directory: { title: "a deployment workflow directory adds a workflow for a freed trigger, rejects duplicate enabled triggers, unknown tools and bad directories", configure: [configureManifestDirectory], run: async () => {
    const { routeFor } = await f.app("workflow-registry.ts");
    const { validateStaticConfig } = await f.app("startup.ts");
    await validateStaticConfig(f.config);
    await assert.rejects(validateStaticConfig({ ...f.config, workflows: { ...f.config.workflows, review_issue: { ...f.config.workflows.review_issue, enabled: true } } }), /review_issue, review_triage would share one review comment on each issue; enable only one/);
    const issue = { source: "github_items", kind: "item_changed", item: "issue", author: "other" };
    assert.equal(routeFor(issue), "review_triage"); assert.equal(routeFor({ ...issue, item: "pr" }), "my_pr_review");
    assert.equal(routeFor({ ...issue, kind: "pr_conflicts", item: "pr", author: "other" }), undefined);
    assert.equal(routeFor({ ...issue, kind: "pr_conflicts", item: "pr", author: "bot" }), "resolve_conflicts");
    f.addIssue(1); await route();
    assert.deepEqual(all(s.tasks).map((t) => t.action), ["review_triage"]);
    const done = await success();
    assert.equal(done.skill, resolve("deployment/review_triage/SKILL.md"));
    assert.equal(f.requests.at(-1).context.action, "review_triage"); assert.ok(f.writes.some((w) => w.type === "comment" && w.number === 1));
    assert.throws(() => f.enqueue(1, "nope"), /Unknown workflow: nope/); assert.throws(() => tasks.enqueueManualTasks("nope", ["1"]), /Unknown action/);
    const local = resolve("app/scrat.local.json"), directory = resolve("deployment");
    const probe = (workflows, extra = {}) => {
      for (const [name, yaml] of Object.entries(extra)) {
        const dir = resolve(directory, name);
        mkdirSync(dir, { recursive: true });
        cpSync(resolve("app/workflows/review_issue/SKILL.md"), resolve(dir, "SKILL.md"));
        writeFileSync(resolve(dir, "workflow.yaml"), yaml);
      }
      writeFileSync(local, JSON.stringify({ workflows }));
      try { return execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(resolve("app/src/config.ts"))});`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { return error.stderr; }
      finally { for (const name of Object.keys(extra)) rmSync(resolve(directory, name), { recursive: true, force: true }); }
    };
    const triage = readFileSync(resolve(directory, "review_triage/workflow.yaml"), "utf8"), named = (name, key, value) => triage.replace("name: review_triage", "name: " + name).replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`);
    const base = { directory, trustLocalScripts: true, review_issue: { enabled: false }, review_pr: { enabled: false } };
    assert.doesNotMatch(probe(base), /Error/);
    assert.match(probe({ directory, trustLocalScripts: true, review_pr: { enabled: false } }), /workflows\/review_issue\/workflow\.yaml and .*review_triage\/workflow\.yaml both match \{source: github_items, kind: item_changed, item: issue\}; disable one/);
    assert.doesNotMatch(probe({ directory, trustLocalScripts: true, review_pr: { enabled: false }, review_triage: { enabled: false } }), /Error/);
    const commits = readFileSync(resolve("app/workflows/review_base_change/workflow.yaml"), "utf8");
    assert.match(probe({ ...base, review_base_change: { enabled: true, branch: "develop" }, dup_commits: { enabled: true } }, { dup_commits: commits.replace("name: review_base_change", "name: dup_commits").replace("enabled: false\n", "enabled: true\n").replace("branch: main", "branch: develop") }), /both match \{source: github_commits, kind: commit, branch: develop\}/);
    assert.match(probe(base, { bad_tool: withTools(named("bad_tool", "priority", "10"), "[teleport]") }), /bad_tool\/workflow\.yaml: \/defaults\/tools\/0/);
    assert.match(probe({ ...base, directory: "relative/workflows" }), /workflows\.directory must be an absolute path/);
    assert.match(probe({ ...base, directory: resolve("missing-workflows") }), /Cannot read workflows in/);
    await implement(2);
    f.reset(202, "grade-C"); await route();
    const queuedFor = (action) => all(s.tasks).filter((t) => t.action === action && t.status === "queued");
    assert.equal(queuedFor("my_pr_review").length, 1); assert.equal(all(s.tasks).filter((t) => t.action === "review_pr").length, 0);
    const reviewed = await success();
    assert.equal(reviewed.result.grade, "C"); assert.ok(f.prs.find((pr) => pr.number === 202).labels.some((label) => label.name === "C \u00b7 Needs work"));
    await route(); assert.equal(queuedFor("address_review").length, 1);
    f.reset(202, "no-change"); const repair = await success();
    assert.equal(repair.error, null); assert.equal(repair.publication.status, "published");
    assert.match(probe(base, { mismatch: named("other_name", "priority", "10") }), /mismatch\/workflow\.yaml: name other_name must equal folder name mismatch/);
  } },
  advisory_workflows: { title: "an advisory workflow runs beside the canonical review without touching its history or maintenance, gates on changed paths, supersedes and retracts per head, triggers workflow_completed followers, and label replays are validated", configure: [(config) => {
    const directory = resolve("deployment");
    mkdirSync(resolve(directory, "advisory_digest"), { recursive: true });
    writeFileSync(resolve(directory, "advisory_digest/workflow.yaml"), [
      "name: advisory_digest", "enabled: true", "on:", "  event:", "    source: workflow", "    kind: workflow_completed", "    workflow: breaking-change-check",
      "defaults:", "  provider: fixture", "  model: gpt-6.2-sol", "  thinkingLevel: low", "",
    ].join("\n"));
    writeFileSync(resolve(directory, "advisory_digest/run.ts"), "export default async function (ctx) { return { parent: ctx.trigger.input.runId, item: ctx.trigger.input.item, publication: ctx.trigger.input.publication }; }\n");
    config.workflows.directory = directory;
    config.workflows.trustLocalScripts = true;
    config.workflows.advisory_digest = { provider: "fixture" };
    Object.assign(config.workflows["breaking-change-check"], { enabled: true, paths: ["^db/"] });
  }], run: async () => {
    const { routeFor, advisoryFor } = await f.app("workflow-registry.ts");
    const { validateStaticConfig } = await f.app("startup.ts");
    const { config: live } = await f.app("config.ts");
    const { pollWorkflowCompletions } = await f.app("workflow-source.ts");
    const { prReviewHistory } = await f.app("pr-assessment.ts");
    await validateStaticConfig(f.config);
    const signal = { source: "github_items", kind: "item_changed", item: "pr", author: "bot" };
    assert.equal(routeFor(signal), "review_pr", "the canonical review still owns item_changed");
    assert.deepEqual(advisoryFor(signal), ["breaking-change-check"]);
    assert.equal(await pollWorkflowCompletions(), 0, "enabling a follower seeds its cursor and queues nothing");

    const check = "breaking-change-check";
    const ofAction = (action, status) => all(s.tasks).filter((t) => t.action === action && (!status || t.status === status));
    const numberOf = (task) => all(s.items).find((item) => item.id === task.subjectId).payload.number;
    const findings = [{ path: "db/001.sql", line: 1, title: "Drops the users table", detail: "Every user row is deleted with no copy.", remedy: "Copy the rows before dropping the table." }];
    const assess = (number, payload, text = "Assessment done.") => { f.reset(number, "normal"); f.script = [{ name: "submit_result", args: payload }, text]; };
    const runTask = async (task) => { const r = await f.runNextTask(undefined, task.id); assert.ok(r); return r; };
    const verdicts = () => f.botComments(201).filter((comment) => comment.body.includes(`<!-- scrat-workflow:${check}:verdict -->`));

    mkdirSync(resolve("seed/db"), { recursive: true }); branchOff("migrate", "db/001.sql", "DROP TABLE users;\n");
    branchOff("plain", "src/app.ts", "export const value = 2;\n");
    f.addPr(201, "migrate", f.config.github.botLogin); f.addPr(202, "plain", "human");
    const pr201 = f.prs.find((pr) => pr.number === 201);
    await route();
    assert.deepEqual(ofAction("review_pr", "queued").map(numberOf).sort(), [201, 202]);
    const [first, ...others] = ofAction(check);
    assert.equal(others.length, 0, "a PR whose changed paths do not match queues nothing");
    assert.equal(numberOf(first), 201); assert.equal(first.priority, 0); assert.equal(first.input.pathsMatched, true);
    assert.equal(f.calls.filter((call) => /\/pulls\/\d+\/files/.test(call.path)).length, 0, "changed paths come from local git");

    assess(201, { status: "complete", findings });
    const flagged = await runTask(first);
    assert.equal(flagged.error, null, JSON.stringify(flagged.error));
    assert.equal(flagged.publication.status, "published");
    assert.equal(verdicts().length, 1); assert.match(verdicts()[0].body, /Drops the users table/);
    assert.deepEqual(pr201.labels, [], "advisory writes no grade or ready labels");
    assert.equal(prReviewHistory(first.subjectId).length, 0, "advisory runs never enter PR review history");

    assert.equal(await pollWorkflowCompletions(), 1);
    const [digestTask] = ofAction("advisory_digest", "queued");
    assert.equal(digestTask.input.runId, flagged.id); assert.deepEqual(digestTask.input.item, { kind: "pr", number: 201 }); assert.equal(digestTask.input.publication, "published");
    const digest = await runTask(digestTask);
    assert.equal(digest.error, null, JSON.stringify(digest.error)); assert.equal(JSON.parse(digest.result.text).parent, flagged.id);
    assert.equal(await pollWorkflowCompletions(), 0, "a follower's own completion does not re-trigger it");

    f.script = undefined; f.reset(201, "normal"); f.reset(202, "normal");
    await success(); await success();
    assert.deepEqual(prReviewHistory(first.subjectId).map(({ task }) => task.action), ["review_pr"]);
    assert.equal(verdicts().length, 1, "the canonical review comment and the advisory comment coexist");
    await route();
    assert.equal(ofAction(check).length, 1, "the evaluated head is covered");
    assert.equal(ofAction("address_review", "queued").length + ofAction("resolve_conflicts", "queued").length, 0);

    changeMain("unrelated.txt", "Base moved\n");
    const manual = tasks.enqueueManualTasks(check, ["201"])[0];
    assess(201, { status: "needs_decision", findings: [] }, "Unsure.");
    const failed = await runTask(ofAction(check, "queued")[0]);
    assert.ok(failed.error); assert.equal(failed.taskId, manual.taskId); assert.equal(failed.headSha, pr201.head.sha);
    db.update(s.runs).set({ stage: "preparing" }).where(eq(s.runs.id, failed.id)).run();
    await route();
    assert.equal(ofAction("resolve_conflicts", "queued").length, 0, "a failed advisory run never reads as a failed branch preparation");
    assert.equal(ofAction(check, "queued").length, 0, "a manual run covers its head");
    assert.equal(prReviewHistory(first.subjectId).length, 1);

    pr201.head.sha = pushFile("migrate", "db/002.sql", "ALTER TABLE orders DROP COLUMN total;\n");
    await route();
    const [moved] = ofAction(check, "queued");
    assert.ok(moved); assert.equal(JSON.parse(moved.input.triggerKey).head, pr201.head.sha);
    f.reset(201, "stall"); f.script = [{ name: "submit_result", args: { status: "complete", findings } }, "Stalled."];
    let pushed;
    f.onModel = (context) => {
      if (pushed || context.action !== check) return;
      pushed = (async () => { pr201.head.sha = pushFile("migrate", "db/003.sql", "TRUNCATE sessions;\n"); await route(); })();
    };
    const superseded = await runTask(moved); f.onModel = undefined; await pushed;
    assert.equal(superseded.error?.code, "RUN_SUPERSEDED"); assert.equal(superseded.error?.message, "Newer PR head observed");
    assert.equal(f.row(s.tasks, moved.id).status, "cancelled");
    const [requeued] = ofAction(check, "queued");
    assert.equal(JSON.parse(requeued.input.triggerKey).head, pr201.head.sha, "the new head re-queues the advisory");
    assess(201, { status: "complete", findings });
    assert.equal((await runTask(requeued)).error, null);
    assert.equal(verdicts().length, 1, "later heads edit the same comment");
    f.script = undefined; f.reset(201, "normal");
    while (ofAction("review_pr", "queued").length) await success();

    for (const path of ["db/001.sql", "db/002.sql", "db/003.sql"]) pr201.head.sha = pushFile("migrate", path, null);
    await route();
    const retractions = ofAction(check, "queued");
    assert.equal(retractions.length, 1); assert.equal(retractions[0].input.pathsMatched, false);
    const requestsBefore = f.requests.length;
    const retracted = await runTask(retractions[0]);
    assert.equal(retracted.error, null, JSON.stringify(retracted.error));
    assert.equal(f.requests.length, requestsBefore, "retraction runs no agent");
    assert.match(verdicts()[0].body, new RegExp(`Resolved at \`${pr201.head.sha.slice(0, 12)}\``));
    f.script = undefined; f.reset(201, "normal");
    while (ofAction("review_pr", "queued").length) await success();
    touchPr(201); await route();
    assert.equal(ofAction(check, "queued").length, 0, "one retraction per published verdict");
    assert.equal(ofAction(check).filter((task) => numberOf(task) === 202).length, 0);
    await pollWorkflowCompletions();
    const completedChecks = all(s.runs).filter((r) => r.finishedAt && !r.error && f.row(s.tasks, r.taskId).action === check).length;
    assert.equal(ofAction("advisory_digest").length, completedChecks, "every completed parent run queues exactly one follower");

    const labels = live.workflows.label_items;
    labels.enabled = true;
    await route();
    const labelTask = ofAction("label_items", "queued").find((task) => numberOf(task) === 202);
    f.reset(202, "normal"); f.script = ["Classified.\nSCRAT_LABELS: [{\"category\":\"risk\",\"name\":\"risk: low\"}]\nSCRAT_STATUS: complete"];
    f.faults.label.add(202);
    const unpublished = await runTask(labelTask);
    assert.ok(unpublished.error); assert.equal(unpublished.stage, "publishing");
    db.update(s.runs).set({ result: { ...unpublished.result, labels: undefined } }).where(eq(s.runs.id, unpublished.id)).run();
    const labelWrites = f.written("label", (w) => w.number === 202).length, modelCalls = f.requests.length;
    tasks.retryTask(labelTask.id);
    const replayed = await runTask(labelTask);
    assert.match(replayed.error?.message ?? "", /SCRAT_LABELS must select exactly one allowed label/);
    assert.equal(replayed.inferenceFromRunId, unpublished.id, "claimTask alone selects the saved snapshot");
    assert.equal(f.requests.length, modelCalls); assert.equal(f.written("label", (w) => w.number === 202).length, labelWrites, "an invalid saved classification changes no labels");

    const local = resolve("app/scrat.local.json"), directory = resolve("deployment");
    const probe = (bundles) => {
      for (const [name, event] of Object.entries(bundles)) {
        mkdirSync(resolve(directory, name), { recursive: true });
        writeFileSync(resolve(directory, name, "run.ts"), "export default async function () { return {}; }\n");
        writeFileSync(resolve(directory, name, "workflow.yaml"), `name: ${name}\non:\n  event: ${event}\ndefaults:\n  provider: fixture\n  model: gpt-6.2-sol\n  thinkingLevel: low\n`);
      }
      writeFileSync(local, JSON.stringify({ workflows: f.config.workflows }));
      try { return execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(resolve("app/src/config.ts"))});`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { return error.stderr; }
      finally { for (const name of Object.keys(bundles)) rmSync(resolve(directory, name), { recursive: true, force: true }); }
    };
    const follows = (parent) => `{ source: workflow, kind: workflow_completed, workflow: ${parent} }`;
    assert.doesNotMatch(probe({ second_digest: follows("advisory_digest") }), /Error/);
    assert.match(probe({ loop_a: follows("loop_b"), loop_b: follows("loop_a") }), /workflow_completed cycle: loop_a -> loop_b -> loop_a/);
    assert.match(probe({ loop_self: follows("loop_self"), orphan: follows("missing") }), /loop_self\/workflow\.yaml: workflow_completed must not follow itself[\s\S]*orphan\/workflow\.yaml: on\.event\.workflow missing is not a loaded workflow|orphan[\s\S]*missing is not a loaded workflow[\s\S]*loop_self/);
    assert.match(probe({ scoped: "{ source: workflow, kind: workflow_completed, workflow: advisory_digest, item: pr }" }), /kind workflow_completed forbids on\.event\.item/);
    assert.match(probe({ loud: "{ source: github_items, kind: item_changed, item: pr, role: advisory, paths: ['[db'] }" }), /on\.event\.paths\[0\] is not a valid regular expression/);
    assert.match(probe({ greedy: "{ source: github_items, kind: item_changed, item: issue, paths: ['^db/'] }" }), /on\.event\.paths requires role advisory and item pr/);
  } },
  manifest_tools_files: { title: "workflow tools and files lists decide which tools and context files reach the agent session, and cross-field rules reject unsafe combinations", configure: [configureManifestDirectory], run: async () => {
    const { readWorkflows } = await f.app("workflows.ts");
    const toolsOf = (request) => request.request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode");
    f.addIssue(1); f.enqueue(1); await success();
    const review = f.requests[0];
    assert.deepEqual(toolsOf(review), ["read", "grep"]); assert.deepEqual(Object.keys(review.context.files), ["directory"]);
    await implement(3); await implement(4);
    const changes = f.requests.filter((r) => r.context.action === "implement");
    assert.deepEqual(toolsOf(changes[0]), ["read", "grep", "find", "ls", "edit", "write"]);
    assert.ok(changes[0].context.files.discussion); assert.equal(changes[0].context.files.history, undefined, "a first run has no history");
    assert.match(readFileSync(changes.at(-1).context.files.history, "utf8"), /Previous implement runs/);
    let count = 0;
    const rejects = (name, change, message) => {
      const directory = resolve("rules-" + ++count); mkdirSync(directory);
      const dest = resolve(directory, "rule_check");
      cpSync(resolve("app/workflows", name), dest, { recursive: true });
      const path = resolve(dest, "workflow.yaml");
      writeFileSync(path, change(readFileSync(path, "utf8").replace("name: " + name, "name: rule_check")));
      assert.throws(() => readWorkflows(resolve("app"), directory), message);
    };
    rejects("review_issue", (text) => withTools(text, "[read, bash]"), /rule_check\/workflow\.yaml: mode review forbids the bash, edit and write tools/);
    rejects("storefront_discover", (text) => withTools(text.replace("mode: review", "mode: change"), "[read, browser]"), /a storefront trigger requires mode review/);
    rejects("implement", (text) => withTools(text, "[read, git]"), /mode change forbids the git and read_base tools/);
    rejects("implement", (text) => text.replace("item: issue", "item: pr"), /on\.event\.kind label requires item: issue/);
    rejects("review_issue", (text) => text + "config:\n  failedLabel: Scrat failed\n", /rule_check\/workflow\.yaml: failedLabel requires mode change/);
  } },
  scoped_http: { title: "the http tool injects its binding's credential after the model's call, refuses off-list, IP, loopback and metadata hosts, never follows redirects, redacts echoed secrets and journals only method, host and status", configure: [configureScoped], run: async () => {
    const secret = process.env.SCOUT_TOKEN;
    const lines = captureLogs();
    const get = (url, extra = {}) => ({ name: "http", args: { method: "GET", url, ...extra } });
    f.script = [
      get("https://api.example.test/data?token=querysecret&x=1", { headers: { Accept: "application/json" } }), get("https://api.example.test/echo"), get("https://other.example.test/ok"),
      get("https://evil.example.net/x"), get("https://169.254.169.254/latest/meta-data/"), get("https://127.0.0.1/"), get("https://[::1]/"), get("https://2130706433/"),
      get("https://api.example.test/redirect-off"), get("https://api.example.test/redirect-on"),
      { name: "http", args: { method: "POST", url: "https://api.example.test/data", body: "payload-body" } },
      get("https://api.example.test/data", { headers: { Authorization: "Bearer mine" } }),
      get("http://api.example.test/data"), get("https://api.example.test:8443/data"), get("https://user:pw@api.example.test/data"),
      get("https://api.example.test/data", { headers: { "X-HTTP-Method-Override": "DELETE" } }), get("https://api.example.test/big"),
    ];
    f.addIssue(1); f.enqueue(1);
    let result;
    try { result = await success(); } finally { restoreLogs(); }
    const sent = f.requests.at(-1).request;
    const textOf = (message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("");
    const answers = sent.messages.filter((message) => message.role === "tool").map(textOf);
    assert.equal(answers.length, 17);
    const reply = (index) => JSON.parse(answers[index]);
    assert.equal(reply(0).status, 200); assert.match(reply(0).body, /"ok":true/);
    assert.match(reply(1).body, /you sent Bearer \[redacted\]/); assert.ok(!answers[1].includes(secret));
    assert.equal(reply(2).status, 200);
    const refusals = [[3, /Refused: evil\.example\.net is not an allowed host/], [4, /Refused: 169\.254\.169\.254 is an IP address/], [5, /Refused: 127\.0\.0\.1 is an IP address/],
      [6, /Refused: \[::1\] is an IP address/], [7, /Refused: 127\.0\.0\.1 is an IP address/], [10, /method POST is not allowed; use one of GET/],
      [11, /header Authorization cannot be set; allowed headers are accept, content-type/], [12, /only https URLs/], [13, /explicit port/], [14, /credentials/], [15, /header X-HTTP-Method-Override cannot be set/]];
    for (const [index, pattern] of refusals) assert.match(answers[index], pattern, `call ${index}`);
    assert.equal(reply(8).status, 302); assert.equal(reply(8).headers.location, undefined); assert.ok(!answers[8].includes("evil.example.net"));
    assert.equal(reply(9).status, 302); assert.equal(reply(9).headers.location, "https://other.example.test/ok");
    assert.equal(reply(16).truncated, true); assert.equal(reply(16).body.length, 64 * 1024);
    assert.deepEqual(f.external.map(({ host, path }) => host + path), ["api.example.test/data?token=querysecret&x=1", "api.example.test/echo", "other.example.test/ok",
      "api.example.test/redirect-off", "api.example.test/redirect-on", "api.example.test/big"]);
    assert.equal(f.external[0].headers.accept, "application/json");
    for (const call of f.external) { assert.equal(call.headers.authorization, "Bearer " + secret); assert.equal(call.redirect, "manual"); assert.equal(call.method, "GET"); }
    assert.ok(!JSON.stringify(sent).includes(secret) && !JSON.stringify(f.requests.map((entry) => entry.request.messages)).includes(secret));
    assert.deepEqual(sent.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), ["read", "grep", "http"]);
    assert.ok(existsSync(result.piSessionFile)); assert.ok(!readFileSync(result.piSessionFile, "utf8").includes(secret));
    const operations = lines.filter((line) => line.operation === "agent.http"), done = operations.filter((line) => line.event === "operation.completed");
    assert.deepEqual(done.map(({ method, host, status }) => [method, host, status]), [["GET", "api.example.test", 200], ["GET", "api.example.test", 200], ["GET", "other.example.test", 200],
      ["GET", "api.example.test", 302], ["GET", "api.example.test", 302], ["GET", "api.example.test", 200]]);
    const journal = JSON.stringify(lines);
    for (const hidden of [secret, "querysecret", "payload-body", "pw@"]) assert.ok(!journal.includes(hidden), hidden);
    const { containsSecret } = await f.app("secrets.ts"), { redactSecrets } = await f.app("errors.ts"), { childEnvironment } = await f.app("secrets.ts");
    assert.ok(containsSecret(`x ${secret} x`)); assert.ok(!redactSecrets(`x ${secret}`).includes(secret)); assert.equal(childEnvironment(process.env).SCOUT_TOKEN, undefined);
    const { createHttpTool } = await f.app("scoped-tools.ts"), { publicAnswers } = await f.app("bindings.ts"), { fetch: networkFetch } = await import("undici");
    const classified = { "127.0.0.1": true, "127.255.0.1": true, "10.1.2.3": true, "172.16.0.1": true, "172.31.255.255": true, "192.168.1.1": true, "169.254.169.254": true, "169.254.1.1": true,
      "100.64.0.1": true, "100.127.255.255": true, "0.0.0.0": true, "::": true, "::1": true, "fe80::1": true, "fc00::1": true, "fd00:ec2::254": true,
      "::ffff:10.0.0.1": true, "::ffff:127.0.0.1": true, "::ffff:169.254.169.254": true, "::ffff:100.64.0.1": true,
      "198.18.0.1": true, "fec0::1": true, "ff02::1": true, "198.17.255.255": false, "8.8.8.8": false, "93.184.216.34": false, "172.32.0.1": false, "100.128.0.1": false, "169.255.0.1": false, "2606:4700::1111": false, "::ffff:8.8.8.8": false };
    for (const [address, refused] of Object.entries(classified)) {
      const outcome = publicAnswers("host.example.test", async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
      if (refused) await assert.rejects(outcome, /resolves to private address/, address); else assert.equal((await outcome)[0].address, address);
    }
    const seen = f.external.length, stubbed = globalThis.fetch;
    globalThis.fetch = networkFetch;
    const attempt = (answer, onResolve = () => {}, signal = undefined) => {
      const asked = [], tool = createHttpTool({ settings: {}, binding: f.config.bindings.scout, runId: "run", resolve: async (host) => { asked.push(host); onResolve(); return [{ address: answer, family: answer.includes(":") ? 6 : 4 }]; } });
      return { asked, run: tool.execute("call", { method: "GET", url: "https://api.example.test/data" }, signal, undefined, {}) };
    };
    try {
      for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.0.1", "fd00:ec2::254", "::ffff:192.168.1.1"]) {
        const { asked, run } = attempt(address);
        await assert.rejects(run, new RegExp(`Refused: api\\.example\\.test resolves to private address ${address.replace(/\./g, "\\.")}`));
        assert.deepEqual(asked, ["api.example.test"]);
      }
      const stop = new AbortController(), { asked, run } = attempt("192.0.2.1", () => { setTimeout(() => stop.abort(), 100); }, stop.signal);
      await assert.rejects(run, (error) => !/Refused/.test(error.message));
      assert.deepEqual(asked, ["api.example.test"]);
    } finally { globalThis.fetch = stubbed; }
    assert.equal(f.external.length, seen);
    const { config } = await f.app("config.ts"), { createReviewGitTool } = await f.app("review-git.ts");
    config.tools.http.maxRequestBytes = 8;
    const post = createHttpTool({ settings: { methods: ["POST"] }, binding: f.config.bindings.scout, runId: "run" });
    await assert.rejects(post.execute("call", { method: "POST", url: "https://api.example.test/data", body: "123456789" }, undefined, undefined, {}), /Refused: body exceeds 8 bytes/);
    const repository = resolve(f.config.github.repositoryPath);
    writeFileSync(resolve(repository, "second.txt"), "second\n"); git(repository, "add", "."); commit(repository, "Second commit");
    const tip = git(repository, "rev-parse", "HEAD");
    assert.equal(git(repository, "rev-list", "--count", "HEAD"), "2");
    config.tools.git.maxCommits = 1;
    const history = await createReviewGitTool(repository, { head: tip }, new Set()).execute("call", { operation: "log" }, undefined, undefined, {});
    assert.equal(history.content[0].text.split("\n").length, 1);
  } },
  scoped_github_search: { title: "the github_search tool forces the configured repository into every query, refuses other scopes and bypasses the ETag cache", configure: [configureScoped], run: async () => {
    const search = (query) => ({ name: "github_search", args: { query } });
    f.script = [search("is:open label:bug"), search("is:open label:bug"), search("repo:other/repo secret"), search("org:evil x"), search("-user:evil x"), search("Repo:other/x y"), search('"timeout"-repo:fixture/project'), search('"x"-repo:fixture/project'), search("\u00a0-repo:fixture/project x"), search("\u200b-repo:fixture/project x")];
    f.addIssue(1); f.enqueue(1); await success();
    const sent = f.requests.at(-1).request;
    const textOf = (message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("");
    const answers = sent.messages.filter((message) => message.role === "tool").map(textOf);
    assert.deepEqual(sent.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), ["read", "grep", "github_search"]);
    assert.equal(answers.length, 10);
    assert.deepEqual(f.searches, [{ q: "repo:fixture/project is:open label:bug", ifNoneMatch: null }, { q: "repo:fixture/project is:open label:bug", ifNoneMatch: null }]);
    for (const index of [0, 1]) {
      const found = JSON.parse(answers[index]);
      assert.equal(found.total, 1); assert.deepEqual(found.items[0], { number: 7, kind: "issue", title: "Known flake", state: "open", url: "https://github.com/fixture/project/issues/7",
        author: "someone", labels: ["bug"], updatedAt: "2026-10-19T00:00:00Z", excerpt: "Seen before. ".repeat(60).slice(0, 300) });
    }
    for (const index of [2, 3, 4, 5, 6, 7, 8, 9]) assert.match(answers[index], /must not contain repo:, org: or user: qualifiers; the search is limited to fixture\/project/);
  } },
  scoped_browser: { title: "the browser tool confines navigation and page resources to its allowlists, injects binding credentials only on binding hosts, caps steps and time, and fails startup when playwright-core is missing", configure: [configureScoped], run: async () => {
    const secret = process.env.SCOUT_TOKEN, binding = f.config.bindings.scout;
    const { createBrowserTool } = await f.app("scoped-tools.ts"), { validateStaticConfig } = await f.app("startup.ts");
    mkdirSync("ctx");
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const fake = () => {
      const state = { closed: false, contexts: 0, launches: 0, handler: undefined, contextOptions: undefined, visited: [], visitViewports: [], clicked: [], typed: [], viewport: undefined, html: "<html></html>", timeouts: [], navigations: [], popups: [], listeners: [] };
      let current = "about:blank";
      const page = {
        async request(url, navigation, headers = { accept: "*/*" }) {
          let outcome;
          await state.handler({ request: () => ({ url: () => url, isNavigationRequest: () => navigation, headers: () => headers }),
            abort: async (code) => { outcome = { aborted: code }; }, continue: async (options) => { outcome = { continued: options?.headers ?? {} }; } });
          return outcome;
        },
        async goto(url, options) { if (options) state.navigations.push(options.timeout); const outcome = await page.request(url, true); if (outcome.aborted) throw new Error("net::ERR_BLOCKED_BY_CLIENT"); state.visited.push(url); state.visitViewports.push(state.viewport ?? state.contextOptions?.viewport); current = url; return { status: () => 200 }; },
        title: async () => "Shop", url: () => current, innerText: async () => "Cart total 5. token " + secret,
        screenshot: async ({ path, fullPage, timeout }) => { state.timeouts.push(timeout); writeFileSync(path, `png ${state.viewport?.width ?? "default"} ${fullPage ?? false}`); },
        innerHTML: async (_selector, { timeout }) => { state.timeouts.push(timeout); return state.html; }, waitForLoadState: async () => {},
        on: (_event, listener) => { state.listeners.push(listener); }, off: (_event, listener) => { state.listeners = state.listeners.filter((entry) => entry !== listener); },
        setViewportSize: async (size) => { state.viewport = size; },
        locator: (selector) => ({
          count: async () => selector === "#missing" || selector === "#all-hidden >> visible=true" ? 0
            : selector.endsWith(" >> visible=true") ? 1 : 2,
          first: () => ({ isVisible: async () => !["#hidden-first", "#hidden-first >> visible=false", "button[data-visible=true]", "#all-hidden"].includes(selector) }),
        }),
        click: async (selector, { timeout }) => {
          state.timeouts.push(timeout);
          state.clicked.push(selector);
          if (selector === "#boom") throw new Error("element detached");
          if (selector === "#covered") throw new Error("page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('#covered')\n    - <div class=\"octane-popup--mask\"></div> from <div class=\"octane-wrapper big\" id=\"w1\">…</div> subtree intercepts pointer events\n  - retrying click action\n    - <iframe id=\"PBarNextFrame\" src=\"https://x/y\" sandbox=\"allow-scripts\"></iframe> intercepts pointer events\n    - <div class=\"octane-popup--mask\"></div> from <div class=\"octane-wrapper big\" id=\"w1\">…</div> subtree intercepts pointer events");
          if (selector === "#popup") for (const listener of state.listeners) listener({ close: async () => { state.popups.push("closed"); } });
          if (selector === "#checkout") await page.goto("https://shop.example.test/checkout");
          if (selector === "#escape") { const outcome = await page.request("https://evil.example.net/", true); if (outcome.aborted) return; }
        },
        fill: async (selector, value) => { state.typed.push(["fill", selector, value]); },
        selectOption: async (selector, value) => { state.typed.push(["select", selector, value]); },
      };
      const browser = { async newContext(options) { state.contextOptions = options; state.viewport = undefined; state.contexts++; return { route: async (_pattern, handler) => { state.handler = handler; }, newPage: async () => page, close: async () => {} }; }, close: async () => { state.closed = true; } };
      return { state, page, launch: async (args) => { state.args = args; state.launches++; return browser; } };
    };
    const warnings = [], settings = { navigationHosts: ["shop.example.test"], resourceHosts: ["cdn.example.test", "api.example.test"] };
    const publicAnswer = [{ address: "93.184.216.34", family: 4 }];
    const make = (extra = {}) => { const stub = fake(), { tool, close } = createBrowserTool({ settings, contextDir: resolve("ctx"), runId: "run", launch: stub.launch, resolve: async () => publicAnswer, log: { warn: (details) => warnings.push(details) }, ...extra }); return { ...stub, tool, close }; };
    const act = (browser, args) => browser.tool.execute("call", args, undefined, undefined, {});
    const textOf = (result) => result.content[0].text;

    const bound = make({ binding });
    assert.deepEqual(Object.keys(bound.tool.parameters.properties), ["action", "url", "selector", "text", "viewport", "fullPage", "focus", "raw"]);
    assert.match(bound.tool.description, /desktop, mobile.*click.*fill.*select/s); assert.doesNotMatch(bound.tool.description, /no way to click/);
    await assert.rejects(act(bound, { action: "teleport" }), /action must be one of: goto, text, screenshot, click, fill, select/);
    await assert.rejects(act(bound, { action: "goto", url: "https://evil.example.net/" }), /Refused: evil\.example\.net is not an allowed host/);
    await assert.rejects(act(bound, { action: "goto", url: "https://cdn.example.test/app.js" }), /Refused: cdn\.example\.test is not an allowed host/);
    await assert.rejects(act(bound, { action: "goto", url: "https://127.0.0.1/" }), /Refused: 127\.0\.0\.1 is an IP address/);
    await assert.rejects(act(bound, { action: "goto", url: "http://shop.example.test/" }), /only https URLs/);
    assert.equal(bound.state.handler, undefined, "refused navigations never start a browser");
    const visit = JSON.parse(textOf(await act(bound, { action: "goto", url: "https://shop.example.test/cart?x=1" })));
    assert.deepEqual(visit, { url: "https://shop.example.test/cart?x=1", status: 200, title: "Shop" });
    assert.deepEqual(bound.state.args, ["--host-resolver-rules=MAP cdn.example.test 93.184.216.34,MAP api.example.test 93.184.216.34,MAP shop.example.test 93.184.216.34"]);
    assert.deepEqual(bound.state.contextOptions, { acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

    const pinned = make({ resolve: async (host) => host === "cdn.example.test" ? [{ address: "2606:4700::1111", family: 6 }] : host === "api.example.test" ? [] : publicAnswer });
    await act(pinned, { action: "goto", url: "https://shop.example.test/" });
    assert.deepEqual(pinned.state.args, ["--host-resolver-rules=MAP cdn.example.test [2606:4700::1111],MAP api.example.test ~NOTFOUND,MAP shop.example.test 93.184.216.34"]);
    const rebound = make({ resolve: async (host) => host === "cdn.example.test" ? [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }] : publicAnswer });
    await assert.rejects(act(rebound, { action: "goto", url: "https://shop.example.test/" }), /Refused: cdn\.example\.test resolves to private address 10\.0\.0\.8/);
    assert.equal(rebound.state.args, undefined, "a privately resolving host never launches Chromium");

    const verdicts = async (browser) => [
      await browser.page.request("https://shop.example.test/checkout", true), await browser.page.request("https://cdn.example.test/app.js", false),
      await browser.page.request("https://shop.example.test/app.js", false), await browser.page.request("https://other.example.test/app.js", false),
      await browser.page.request("https://evil.example.net/p.gif", false), await browser.page.request("https://cdn.example.test/frame", true),
      await browser.page.request("http://shop.example.test/x", false), await browser.page.request("https://169.254.169.254/latest", false),
      await browser.page.request("https://127.0.0.1/", false), await browser.page.request("https://shop.example.test:8443/", false),
      await browser.page.request("https://user:pw@shop.example.test/", false), await browser.page.request("not a url", false),
    ];
    const blocked = { aborted: "blockedbyclient" }, open = { continued: {} }, plain = { continued: { accept: "*/*" } };
    assert.deepEqual(await verdicts(bound), [plain, plain, plain, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked]);
    assert.deepEqual(await bound.page.request("https://api.example.test/v1", false), { continued: { accept: "*/*", authorization: "Bearer " + secret } });
    assert.deepEqual(await bound.page.request("https://api.example.test/v1", false, { accept: "*/*", authorization: "Bearer stolen" }), { continued: { accept: "*/*", authorization: "Bearer " + secret } });
    assert.deepEqual(await bound.page.request("https://cdn.example.test/x", false, { accept: "*/*", authorization: "Bearer " + secret }), { continued: { accept: "*/*" } });
    assert.equal(bound.tool.executionMode, "sequential");
    assert.equal(warnings.length, 9); assert.ok(warnings.every((warning) => warning.event === "browser.request_blocked" && warning.runId === "run"));
    const anonymous = make();
    await act(anonymous, { action: "goto", url: "https://shop.example.test/" });
    assert.deepEqual(await anonymous.page.request("https://api.example.test/v1", false), open);
    assert.deepEqual(await verdicts(anonymous), [open, open, open, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked]);

    const content = textOf(await act(bound, { action: "text" }));
    assert.match(content, /Cart total 5/); assert.ok(content.includes("[redacted]") && !content.includes(secret));
    await assert.rejects(act(bound, { action: "click" }), /action click needs a selector/);
    await assert.rejects(act(bound, { action: "fill", selector: "#q" }), /action fill needs text/);
    await act(bound, { action: "text", viewport: "" });
    await assert.rejects(act(bound, { action: "screenshot", viewport: "tablet" }), /viewport must be one of: desktop, mobile/);
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "click", selector: "#missing" }))), { url: "https://shop.example.test/cart?x=1", title: "Shop", matched: 0 });
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "click", selector: "#noop" }))), { url: "https://shop.example.test/cart?x=1", title: "Shop", matched: 2 });
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "click", selector: "#checkout" }))), { url: "https://shop.example.test/checkout", title: "Shop" });
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "click", selector: "#escape" }))), { url: "https://shop.example.test/checkout", title: "Shop", matched: 2, blocked: "https://evil.example.net/" });
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "click", selector: "#popup" }))), { url: "https://shop.example.test/checkout", title: "Shop", matched: 2, popupClosed: true });
    assert.deepEqual(bound.state.popups, ["closed"]); assert.equal(bound.state.listeners.length, 0);
    await assert.rejects(act(bound, { action: "click", selector: "#boom" }), /element detached/); assert.equal(bound.state.listeners.length, 0);
    await assert.rejects(act(bound, { action: "click", selector: "#covered" }), (error) => error.message === "click on #covered was blocked after 12 s: div#w1.octane-wrapper.big, iframe#PBarNextFrame intercepted pointer events. If one is an overlay such as a popup or consent banner, close it (its close button, Escape or a click outside) and retry; otherwise scroll or use another element.");
    await assert.rejects(act(bound, { action: "screenshot", viewport: "constructor" }), /viewport must be one of: desktop, mobile/);
    assert.equal(bound.state.visited.at(-1), "https://shop.example.test/checkout");
    assert.deepEqual(JSON.parse(textOf(await act(bound, { action: "fill", selector: "#q", text: "socks" }))).matched, 2);
    await act(bound, { action: "select", selector: "#size", text: "M" });
    assert.deepEqual(bound.state.typed, [["fill", "#q", "socks"], ["select", "#size", "M"]]);
    const plainShot = JSON.parse(textOf(await act(bound, { action: "screenshot" })));
    assert.deepEqual(plainShot, { path: resolve("ctx/screenshot-current-1.png"), viewport: null, url: "https://shop.example.test/checkout" });
    assert.equal(readFileSync(plainShot.path, "utf8"), "png default false");
    bound.state.html = '<script>var Shopify = Shopify || {}; Shopify.theme = {"name":"Preview","id":1234567,"role":"unpublished"};</script>';
    const mobileShot = JSON.parse(textOf(await act(bound, { action: "screenshot", viewport: "mobile", fullPage: true })));
    assert.deepEqual(mobileShot, { path: resolve("ctx/screenshot-mobile-2.png"), viewport: "mobile", url: "https://shop.example.test/checkout", themeId: 1234567 });
    assert.equal(readFileSync(mobileShot.path, "utf8"), "png 390 true"); assert.deepEqual(bound.state.viewport, { width: 390, height: 844 });
    const desktopShot = JSON.parse(textOf(await act(bound, { action: "screenshot", viewport: "desktop" })));
    assert.equal(desktopShot.path, resolve("ctx/screenshot-desktop-3.png")); assert.deepEqual(bound.state.viewport, { width: 1280, height: 800 });
    for (const html of ["<script>Shopify.theme = {broken</script>", '<script>Shopify.theme = {"id":"1234"};</script>', '<script>Shopify.theme = {"id":1e400};</script>', "<script>Shopify.theme = {</script>"]) {
      bound.state.html = html;
      assert.equal(JSON.parse(textOf(await act(bound, { action: "screenshot" }))).themeId, undefined, html);
    }
    assert.ok(bound.state.timeouts.length > 0 && bound.state.timeouts.every((timeout) => timeout === 12000));
    assert.ok(bound.state.navigations.length > 0 && bound.state.navigations.every((timeout) => timeout === 30000));
    const ledger = readFileSync(resolve("ctx/screenshots.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(ledger.slice(0, 3), [plainShot, { path: mobileShot.path, viewport: "mobile", url: mobileShot.url }, { path: desktopShot.path, viewport: "desktop", url: desktopShot.url }]);
    assert.equal(ledger.length, 7, "every screenshot is recorded with its viewport and URL");
    await assert.rejects(act(make({ contextDir: undefined }), { action: "screenshot" }), /no context directory/);
    const lookups = [], inside = [{ address: "10.0.0.5", family: 4 }];
    const unrestricted = make({ settings: { navigationHosts: "any", resourceHosts: "any" }, resolve: async (host) => { lookups.push(host); return host.startsWith("inside.") ? inside : host.startsWith("nowhere.") ? [] : publicAnswer; } });
    assert.match(unrestricted.tool.description, /^Drive a headless browser on public https sites\. IP addresses, local host names, explicit ports, URLs with credentials and names that resolve to private addresses are blocked\./);
    for (const host of ["inside.example.net", "nowhere.example.net"]) await assert.rejects(act(unrestricted, { action: "goto", url: `https://${host}/` }), new RegExp(`Refused: ${host.replaceAll(".", "\\.")} does not resolve to a public address`));
    for (const [url, refusal] of [["https://127.0.0.1/", /IP address/], ["http://anywhere.example.net/", /only https/], ["https://anywhere.example.net:8443/", /explicit port/], ["https://metadata.google.internal/", /Refused/]]) await assert.rejects(act(unrestricted, { action: "goto", url }), refusal);
    assert.deepEqual(JSON.parse(textOf(await act(unrestricted, { action: "goto", url: "https://anywhere.example.net/p" }))).url, "https://anywhere.example.net/p");
    assert.deepEqual(unrestricted.state.args, [], "an unrestricted browser pins no hosts");
    assert.deepEqual([await unrestricted.page.request("https://cdn.elsewhere.example.org/a.js", false), await unrestricted.page.request("https://frame.example.org/", true), await unrestricted.page.request("http://cdn.elsewhere.example.org/a.js", false), await unrestricted.page.request("https://10.0.0.8/", false),
      await unrestricted.page.request("https://inside.example.org/a.js", false), await unrestricted.page.request("https://inside.example.org/frame", true), await unrestricted.page.request("https://cdn.elsewhere.example.org/b.js", false)],
      [open, open, blocked, blocked, blocked, blocked, open]);
    assert.deepEqual(lookups.filter((host) => host === "cdn.elsewhere.example.org" || host === "inside.example.org"), ["cdn.elsewhere.example.org", "inside.example.org"], "each host is resolved once per session");
    unrestricted.state.html = '<script>Shopify.theme = {"name":"Preview","id":42};</script>';
    assert.equal(JSON.parse(textOf(await act(unrestricted, { action: "goto", url: "https://anywhere.example.net/t" }))).themeId, 42, "goto reports the served theme");
    assert.equal(JSON.parse(textOf(await act(unrestricted, { action: "click", selector: "#noop" }))).themeId, 42, "click reports the served theme");
    await act(unrestricted, { action: "screenshot", viewport: "mobile" });
    assert.deepEqual(JSON.parse(textOf(await act(unrestricted, { action: "reset" }))), { reset: true });
    assert.deepEqual({ closed: unrestricted.state.closed, contexts: unrestricted.state.contexts }, { closed: false, contexts: 1 });
    await act(unrestricted, { action: "goto", url: "https://anywhere.example.net/q" });
    assert.deepEqual({ launches: unrestricted.state.launches, contexts: unrestricted.state.contexts, viewport: unrestricted.state.contextOptions.viewport }, { launches: 1, contexts: 2, viewport: { width: 390, height: 844 } }, "a reset opens a fresh context in the same browser at the viewport last set");
    // Issue #223: viewport passed to goto applies before loading (both fresh context and existing session) and persists only to the immediate pre-interaction screenshot.
    const preSized = make();
    await act(preSized, { action: "goto", url: "https://shop.example.test/m", viewport: "mobile" });
    assert.deepEqual(preSized.state.contextOptions.viewport, { width: 390, height: 844 }, "first goto with viewport opens context at that size");
    assert.deepEqual(preSized.state.visitViewports, [{ width: 390, height: 844 }]);
    await assert.rejects(act(preSized, { action: "goto", url: "https://evil.example.net/", viewport: "desktop" }), /Refused/);
    const inheritedMobile = JSON.parse(textOf(await act(preSized, { action: "screenshot", fullPage: true })));
    assert.equal(inheritedMobile.viewport, "mobile", "first screenshot after goto inherits its viewport and refused goto does not mutate it");
    assert.equal(inheritedMobile.path, resolve("ctx/screenshot-mobile-1.png"));
    const secondShot = JSON.parse(textOf(await act(preSized, { action: "screenshot" })));
    assert.equal(secondShot.viewport, null, "later ad-hoc screenshots without viewport do not pollute named baselines");
    await act(preSized, { action: "goto", url: "https://shop.example.test/d", viewport: "desktop" });
    assert.deepEqual(preSized.state.visitViewports.at(-1), { width: 1280, height: 800 }, "goto on existing session resizes before loading");
    await act(preSized, { action: "click", selector: "#checkout" });
    const postInteractionShot = JSON.parse(textOf(await act(preSized, { action: "screenshot" })));
    assert.equal(postInteractionShot.viewport, null, "post-interaction screenshot without viewport stays null");
    await act(preSized, { action: "reset" });
    await act(preSized, { action: "goto", url: "https://shop.example.test/m2", viewport: "mobile" });
    assert.deepEqual(preSized.state.contextOptions.viewport, { width: 390, height: 844 }, "goto with viewport after reset opens fresh context at that size");
    assert.deepEqual(preSized.state.visitViewports.at(-1), { width: 390, height: 844 });
    const hiddenClick = JSON.parse(textOf(await act(preSized, { action: "click", selector: "#hidden-first" })));
    assert.equal(preSized.state.clicked.at(-1), "#hidden-first >> visible=true", "multi-match click prefers visible match when first DOM match is hidden");
    assert.equal(hiddenClick.visibleMatch, true, "visible fallback is reported in the result");
    const attrClick = JSON.parse(textOf(await act(preSized, { action: "click", selector: "button[data-visible=true]" })));
    assert.equal(preSized.state.clicked.at(-1), "button[data-visible=true] >> visible=true", "attribute selectors containing visible= still use visible fallback");
    assert.equal(attrClick.visibleMatch, true);
    const allHiddenClick = JSON.parse(textOf(await act(preSized, { action: "click", selector: "#all-hidden" })));
    assert.equal(preSized.state.clicked.at(-1), "#all-hidden", "when no match is currently visible, keep the original selector");
    assert.equal(allHiddenClick.visibleMatch, undefined);
    const explicitHidden = JSON.parse(textOf(await act(preSized, { action: "click", selector: "#hidden-first >> visible=false" })));
    assert.equal(preSized.state.clicked.at(-1), "#hidden-first >> visible=false", "explicit Playwright visible= engine is preserved");
    assert.equal(explicitHidden.visibleMatch, undefined);
    const hiddenFill = JSON.parse(textOf(await act(preSized, { action: "fill", selector: "#hidden-first", text: "hi" })));
    assert.deepEqual(preSized.state.typed.at(-1), ["fill", "#hidden-first >> visible=true", "hi"]);
    assert.equal(hiddenFill.visibleMatch, true);
    await preSized.close();
    const named = make({ prefix: "reviewer-2" });
    assert.equal(JSON.parse(textOf(await act(named, { action: "screenshot" }))).path, resolve("ctx/screenshot-reviewer-2-current-1.png"), "each reviewer's screenshots are named apart");
    assert.equal(JSON.parse(readFileSync(resolve("ctx/screenshots.jsonl"), "utf8").trim().split("\n").at(-1)).path, resolve("ctx/screenshot-reviewer-2-current-1.png"), "the screenshot record carries the reviewer's file name");
    const counted = make({ limits: { steps: 2, milliseconds: 60_000 } });
    await act(counted, { action: "goto", url: "https://shop.example.test/" }); await act(counted, { action: "reset" });
    await assert.rejects(act(counted, { action: "text" }), /limited to 2 actions per session/, "a reset counts as an action");
    const resetting = make({ limits: { steps: 10, milliseconds: 600 } });
    await act(resetting, { action: "goto", url: "https://shop.example.test/" }); await act(resetting, { action: "reset" }); await sleep(650);
    await assert.rejects(act(resetting, { action: "goto", url: "https://shop.example.test/" }), /limited to 1 seconds per session/, "a reset does not restart the session's time");
    await bound.close(); assert.equal(bound.state.closed, true);

    const capped = make({ limits: { steps: 3, milliseconds: 60_000 } });
    await act(capped, { action: "goto", url: "https://shop.example.test/" });
    await assert.rejects(act(capped, { action: "click", selector: "#boom" }), /element detached/); await act(capped, { action: "fill", selector: "#q", text: "x" });
    await assert.rejects(act(capped, { action: "click", selector: "#noop" }), /Refused: the browser is limited to 3 actions per session/);
    assert.equal(capped.state.closed, true);
    const slow = make({ limits: { steps: 10, milliseconds: 1000 } });
    await act(slow, { action: "goto", url: "https://shop.example.test/" }); await sleep(1100);
    await assert.rejects(act(slow, { action: "text" }), /limited to 1 seconds per session/);
    await assert.rejects(act(slow, { action: "goto", url: "https://shop.example.test/" }), /limited to 1 seconds per session/);
    assert.equal(slow.state.closed, true); assert.equal(slow.state.visited.length, 1);
    const { config: liveConfig } = await f.app("config.ts"); liveConfig.tools.browser.steps = 2;
    const configured = make();
    for (let n = 0; n < 2; n++) await act(configured, { action: "goto", url: "https://shop.example.test/" });
    await assert.rejects(act(configured, { action: "text" }), /limited to 2 actions per session/);

    const installed = await import("playwright-core").then(() => true, () => false);
    if (!installed) await assert.rejects(validateStaticConfig({ ...f.config, resolve: async () => publicAnswer }), /review_issue: The browser tool needs the optional playwright-core package, which is not installed/);
    f.addIssue(1); f.enqueue(1); await success();
    assert.deepEqual(f.requests.at(-1).request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), ["read", "grep", "browser"]);
  } },
  bindings_startup: { title: "a binding host that resolves privately stops startup while an unresolvable one does not, a workflow naming an unknown binding is rejected at load, and tool settings are validated structurally", configure: [configureScoped], run: async () => {
    const secret = process.env.SCOUT_TOKEN;
    const { validateStaticConfig } = await f.app("startup.ts"), { readWorkflows } = await f.app("workflows.ts");
    const publicAnswer = [{ address: "93.184.216.34", family: 4 }], resolving = (answers) => async (host) => answers[host] ?? publicAnswer;
    await validateStaticConfig({ ...f.config, resolve: resolving({}) });
    for (const address of ["10.0.0.9", "fd00:ec2::254"]) {
      await assert.rejects(validateStaticConfig({ ...f.config, resolve: resolving({ "other.example.test": [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] }) }), /other\.example\.test resolves to private address/);
    }
    await validateStaticConfig({ ...f.config, resolve: async (host) => { if (host === "other.example.test") throw new Error("ENOTFOUND"); return publicAnswer; } });

    const local = resolve("app/scrat.local.json"), original = readFileSync(local, "utf8"), directory = resolve("deployment");
    const probe = (overrides) => {
      writeFileSync(local, JSON.stringify(overrides));
      try { return execFileSync(process.execPath, ["--input-type=module", "-e", `const { config } = await import(${JSON.stringify(resolve("app/src/config.ts"))}); console.log(JSON.stringify(config.bindings));`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { return error.stderr; }
    };
    const manifestFile = resolve(directory, "review_issue/workflow.yaml"), manifest = readFileSync(manifestFile, "utf8");
    assert.deepEqual(JSON.parse(probe(JSON.parse(original))).scout.hosts, ["api.example.test", "other.example.test"]);
    const extra = { secret: "${SCOUT_TOKEN}", hosts: ["x.example.test"], header: "X-Api-Key" };
    assert.deepEqual(Object.keys(JSON.parse(probe({ ...JSON.parse(original), bindings: { extra } }))), ["scout", "extra"]);
    writeFileSync(manifestFile, manifest.replace("binding: scout", "binding: nope"));
    assert.match(probe(JSON.parse(original)), /review_issue\/workflow\.yaml: unknown binding nope; define it under bindings in scrat\.local\.json/);
    writeFileSync(manifestFile, manifest);
    writeFileSync(local, original);

    let count = 0;
    const invalid = (name, change, message) => {
      const rules = resolve("rules-" + ++count); mkdirSync(rules);
      const dest = resolve(rules, "rule_check");
      cpSync(resolve("app/workflows", name), dest, { recursive: true });
      const path = resolve(dest, "workflow.yaml");
      writeFileSync(path, change(readFileSync(path, "utf8").replace("name: " + name, "name: rule_check")));
      assert.throws(() => readWorkflows(resolve("app"), rules), message);
    };
    const mutual = (kind) => new RegExp(`the ${kind} tool and the ${kind} setting require each other`);
    invalid("review_issue", (text) => withTools(text, "[read, http]"), mutual("http"));
    invalid("review_issue", (text) => text + "http: { binding: scout }\n", mutual("http"));
    invalid("review_issue", (text) => withTools(text, "[read, browser]"), mutual("browser"));
    invalid("review_issue", (text) => text + "browser: { navigationHosts: [shop.example.test], resourceHosts: [] }\n", mutual("browser"));
    invalid("review_issue", (text) => withTools(text, "[read, browser]") + "browser: { navigationHosts: [127.0.0.1], resourceHosts: [] }\n", /browser: 127\.0\.0\.1 is an IP address/);
    invalid("review_issue", (text) => withTools(text, "[read, browser]") + 'browser: { navigationHosts: [shop.example.test], resourceHosts: ["*.example.test"] }\n', /browser: \*\.example\.test is not an exact public hostname/);
    invalid("review_issue", (text) => withTools(text, "[read, http]") + "http: { binding: scout, methods: [TRACE] }\n", /rule_check\/workflow\.yaml: \/http\/methods\/0/);
    invalid("review_issue", (text) => withTools(text, "[read, http]") + "http: { binding: scout, hosts: [x.example.test] }\n", /rule_check\/workflow\.yaml: \/http\/hosts: unknown key/);
    invalid("implement", (text) => withTools(text, "[read, bash, github_search]"), /github_search requires mode review/);
    const accepted = resolve("accepted"); mkdirSync(accepted);
    const scopedDir = resolve(accepted, "scoped_check");
    cpSync(resolve("app/workflows/review_issue"), scopedDir, { recursive: true });
    writeFileSync(resolve(scopedDir, "workflow.yaml"), withTools(readFileSync(resolve(scopedDir, "workflow.yaml"), "utf8").replace("name: review_issue", "name: scoped_check"), "[read, github_search, http]") + "http: { binding: scout, methods: [GET, POST] }\n");
    assert.deepEqual(readWorkflows(resolve("app"), accepted).find((entry) => entry.name === "scoped_check").http, { binding: "scout", methods: ["GET", "POST"] });

    const { containsSecret } = await f.app("secrets.ts"), { redactSecrets } = await f.app("errors.ts"), { childEnvironment } = await f.app("secrets.ts");
    assert.ok(containsSecret(`x ${secret} x`)); assert.ok(!redactSecrets(`x ${secret}`).includes(secret)); assert.equal(childEnvironment(process.env).SCOUT_TOKEN, undefined);
  } },
  schedule_source: { title: "the schedule source parses cron expressions, seeds silently, fires one window task per due tick, fires a missed tick once, keeps a cursor per workflow and stops when disabled", configure: [configureSchedule], run: async () => {
    const { parseCron, nextTick, parseWindow } = await f.app("cron.ts");
    const { pollSchedules } = await f.app("schedule-source.ts");
    const { readWorkflows } = await f.app("workflows.ts");
    const { config: live } = await f.app("config.ts");
    const next = (expression, after) => nextTick(parseCron(expression), new Date(after)).toISOString();
    const table = [
      ["* * * * *", "2026-10-21T10:00:30Z", "2026-10-21T10:01:00.000Z"],
      ["* * * * *", "2026-10-21T10:00:00Z", "2026-10-21T10:01:00.000Z"],
      ["*/15 * * * *", "2026-10-21T10:07:00Z", "2026-10-21T10:15:00.000Z"],
      ["*/15 * * * *", "2026-10-21T10:45:00Z", "2026-10-21T11:00:00.000Z"],
      ["0 */6 * * *", "2026-10-21T06:00:00Z", "2026-10-21T12:00:00.000Z"],
      ["0 */6 * * *", "2026-10-21T23:59:59Z", "2026-10-22T00:00:00.000Z"],
      ["30 9-17/4 * * *", "2026-10-21T10:00:00Z", "2026-10-21T13:30:00.000Z"],
      ["5,35 8 * * *", "2026-10-21T08:05:00Z", "2026-10-21T08:35:00.000Z"],
      ["5,35 8 * * *", "2026-10-21T08:35:00Z", "2026-10-22T08:05:00.000Z"],
      ["0 0 1,15 * *", "2026-10-21T00:00:00Z", "2026-11-01T00:00:00.000Z"],
      ["0 12 * * 1-5", "2026-10-23T12:00:00Z", "2026-10-26T12:00:00.000Z"],
      ["0 0 * * 7", "2026-10-21T00:00:00Z", "2026-10-25T00:00:00.000Z"],
      ["0 0 * * 0", "2026-10-21T00:00:00Z", "2026-10-25T00:00:00.000Z"],
      ["0 0 13 * 5", "2026-10-21T00:00:00Z", "2026-10-23T00:00:00.000Z"],
      ["0 0 1 */3 *", "2026-10-21T00:00:00Z", "2027-01-01T00:00:00.000Z"],
      ["0 0 29 2 *", "2026-10-21T00:00:00Z", "2028-02-29T00:00:00.000Z"],
      ["59 23 31 12 *", "2026-10-21T00:00:00Z", "2026-12-31T23:59:00.000Z"],
    ];
    for (const [expression, after, expected] of table) assert.equal(next(expression, after), expected, `${expression} after ${after}`);
    for (const bad of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1-2-3 * * * *", "1//2 * * * *", ",1 * * * *"]) {
      assert.throws(() => parseCron(bad), /cron/i, bad);
    }
    assert.throws(() => nextTick(parseCron("0 0 31 2 *"), new Date(0)), /never matches/);
    assert.deepEqual(["90m", "6h", "1d"].map(parseWindow), [5_400_000, 21_600_000, 86_400_000]);
    for (const bad of ["6", "0h", "h", "6 h", "1w", "1.5h", "-1h"]) assert.throws(() => parseWindow(bad), /window/, bad);

    let count = 0;
    const broken = (name, change, message) => {
      const root = resolve("broken-" + ++count); mkdirSync(root);
      cpSync(resolve("app/workflows"), resolve(root, "workflows"), { recursive: true });
      const path = resolve(root, "workflows", name, "workflow.yaml");
      writeFileSync(path, change(readFileSync(path, "utf8")));
      assert.throws(() => readWorkflows(root), message);
    };
    const replaceOn = (text, replacement) => text.replace(/^on:\n(?:  .*\n)+/m, `on:\n${replacement}\n`);
    broken("implement", (text) => replaceOn(text, '  cron: "0 * * * *"\n  window: 1h'), /a schedule trigger requires mode review/);
    broken("review_issue", (text) => replaceOn(text, '  cron: "0 * * *"\n  window: 1h'), /needs 5 fields/);
    broken("review_issue", (text) => replaceOn(text, '  cron: "0 * * * *"\n  window: "6"'), /A window must be/);
    broken("review_issue", (text) => replaceOn(text, '  cron: "0 0 31 2 *"\n  window: 1h'), /never matches/);
    broken("review_issue", (text) => replaceOn(text, "  window: 1h"), /on\.window requires on\.cron/);

    const cursors = () => Object.fromEntries(all(s.sourceCursors).map((row) => [row.action, JSON.parse(row.sha).next]));
    const tasksOf = (action) => all(s.tasks).filter((t) => t.action === action);
    const poll = (at) => pollSchedules(undefined, new Date(at));
    const first = "2026-10-21T12:00:00.000Z", monday = "2026-10-26T03:30:00.000Z";
    assert.equal(await poll("2026-10-21T10:20:00Z"), 0);
    assert.deepEqual(cursors(), { error_sweep: first, slow_sweep: monday });
    assert.deepEqual(all(s.sourceCursors).map((row) => [row.repository, row.branch]), [["fixture/project", "schedule"], ["fixture/project", "schedule"]]);
    assert.equal(all(s.tasks).length, 0); assert.equal(all(s.subjects).length, 0); assert.equal(all(s.items).length, 0);
    assert.equal(await poll("2026-10-21T11:59:59Z"), 0); assert.equal(all(s.tasks).length, 0);
    assert.equal(await poll("2026-10-21T12:00:00Z"), 1);
    const [task] = tasksOf("error_sweep");
    assert.deepEqual(task.input, { source: "schedule", kind: "tick", triggerKey: first, start: "2026-10-21T06:00:00.000Z", end: first });
    assert.equal(task.reason, "schedule tick " + first); assert.equal(task.status, "queued"); assert.equal(task.priority, 20);
    const subject = f.row(s.subjects, task.subjectId);
    assert.equal(subject.kind, "window"); assert.equal(subject.state, "open"); assert.equal(subject.repository, "fixture/project"); assert.equal(subject.workspaceId, null);
    assert.equal(subject.key, "error_sweep:" + first); assert.deepEqual(subject.metadata, { start: "2026-10-21T06:00:00.000Z", end: first });
    assert.equal(all(s.items).length, 0); assert.equal(all(s.tasks).length, 1);
    assert.deepEqual(cursors(), { error_sweep: "2026-10-21T18:00:00.000Z", slow_sweep: monday });
    assert.equal(await poll("2026-10-21T12:00:01Z"), 0); assert.equal(await poll("2026-10-21T17:59:59Z"), 0);
    assert.equal(all(s.tasks).length, 1); assert.equal(all(s.subjects).length, 1);
    assert.equal(await poll("2026-10-22T05:10:00Z"), 1);
    const missed = tasksOf("error_sweep").find((t) => t.input.triggerKey !== first);
    assert.deepEqual(missed.input, { source: "schedule", kind: "tick", triggerKey: "2026-10-22T00:00:00.000Z", start: "2026-10-21T18:00:00.000Z", end: "2026-10-22T00:00:00.000Z" });
    assert.equal(tasksOf("error_sweep").length, 2); assert.equal(all(s.subjects).length, 2);
    assert.deepEqual(cursors(), { error_sweep: "2026-10-22T06:00:00.000Z", slow_sweep: monday });
    db.update(s.sourceCursors).set({ sha: "2026-10-22T00:00:00.000Z" }).where(eq(s.sourceCursors.action, "error_sweep")).run();
    assert.equal(await poll("2026-10-22T05:20:00Z"), 0);
    assert.equal(tasksOf("error_sweep").length, 2); assert.equal(cursors().error_sweep, "2026-10-22T06:00:00.000Z");
    assert.equal(await poll("2026-10-26T03:30:00Z"), 2);
    assert.equal(tasksOf("slow_sweep").length, 1); assert.equal(tasksOf("error_sweep").length, 3);
    assert.deepEqual(tasksOf("slow_sweep")[0].input, { source: "schedule", kind: "tick", triggerKey: monday, start: "2026-10-25T03:30:00.000Z", end: monday });
    assert.equal(tasksOf("slow_sweep")[0].priority, 20);
    assert.equal(tasksOf("error_sweep").at(-1).input.end, "2026-10-26T00:00:00.000Z");
    assert.deepEqual(cursors(), { error_sweep: "2026-10-26T06:00:00.000Z", slow_sweep: "2026-11-02T03:30:00.000Z" });
    live.workflows.error_sweep.enabled = false;
    assert.equal(await poll("2026-10-26T07:00:00Z"), 0);
    assert.deepEqual(cursors(), { slow_sweep: "2026-11-02T03:30:00.000Z" }); assert.equal(all(s.tasks).length, 4);
    assert.equal(await poll("2026-10-27T07:00:00Z"), 0); assert.equal(all(s.tasks).length, 4);
    live.workflows.error_sweep.enabled = true;
    assert.equal(await poll("2026-10-27T07:00:00Z"), 0);
    assert.deepEqual(cursors(), { error_sweep: "2026-10-27T12:00:00.000Z", slow_sweep: "2026-11-02T03:30:00.000Z" }); assert.equal(all(s.tasks).length, 4);
    assert.equal(all(s.sourceCursors).length, 2);
    const { validateStaticConfig } = await f.app("startup.ts"), withWorkflow = (name, change) => ({ ...f.config, workflows: { ...f.config.workflows, [name]: { ...f.config.workflows[name], ...change } } });
    await validateStaticConfig(withWorkflow("error_sweep", { cron: "0 */4 * * *", window: "4h" }));
    await assert.rejects(validateStaticConfig(withWorkflow("error_sweep", { cron: "0 * * *" })), /workflows\.error_sweep\.cron: A cron expression needs 5 fields/);
    await assert.rejects(validateStaticConfig(withWorkflow("error_sweep", { window: "6" })), /workflows\.error_sweep\.window: A window must be/);
    await assert.rejects(validateStaticConfig(withWorkflow("review_issue", { cron: "0 * * * *" })), /review_issue: cron and window are only allowed on scheduled workflows/);
    const logs = captureLogs();
    Object.assign(live.workflows.error_sweep, { cron: "0 */4 * * *", window: "4h" });
    assert.equal(await poll("2026-10-27T07:30:00Z"), 0);
    restoreLogs();
    const reseeded = logs.find((line) => line.event === "schedule.reseeded");
    assert.deepEqual([reseeded.action, reseeded.from, reseeded.to, reseeded.next], ["error_sweep", { cron: "0 */6 * * *", window: "6h" }, { cron: "0 */4 * * *", window: "4h" }, "2026-10-27T08:00:00.000Z"]);
    assert.deepEqual(cursors(), { error_sweep: "2026-10-27T08:00:00.000Z", slow_sweep: "2026-11-02T03:30:00.000Z" }); assert.equal(all(s.tasks).length, 4);
    assert.equal(await poll("2026-10-27T07:59:59Z"), 0); assert.equal(all(s.tasks).length, 4);
    assert.equal(await poll("2026-10-27T08:00:00Z"), 1);
    assert.deepEqual(tasksOf("error_sweep").at(-1).input, { source: "schedule", kind: "tick", triggerKey: "2026-10-27T08:00:00.000Z", start: "2026-10-27T04:00:00.000Z", end: "2026-10-27T08:00:00.000Z" });
    assert.deepEqual(cursors(), { error_sweep: "2026-10-27T12:00:00.000Z", slow_sweep: "2026-11-02T03:30:00.000Z" });
  } },
  window_review: { title: "a schedule-triggered review runs on the base branch with the window bounds, reads no GitHub item, publishes through its listed issue effect and sees its earlier reports as history", configure: [configureSchedule], run: async () => {
    const { pollSchedules } = await f.app("schedule-source.ts");
    const poll = (at) => pollSchedules(undefined, new Date(at));
    const tip = git(resolve("remote.git"), "rev-parse", "main");
    const requests = () => f.requests.filter((request) => request.context.action === "error_sweep");
    f.reset(0, "issues");
    assert.equal(await poll("2026-10-21T10:20:00Z"), 0); assert.equal(await poll("2026-10-21T12:00:00Z"), 1);
    f.calls.length = 0;
    const r = await success();
    assert.equal(r.stage, "publishing"); assert.equal(r.publication.status, "published"); assert.equal(r.context.item.number, 0);
    assert.equal(r.mainSha, tip); assert.equal(r.headSha, tip); assert.equal(f.row(s.tasks, r.taskId).status, "completed");
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt); assert.equal(all(s.subjects)[0].workspaceId, null);
    assert.deepEqual(f.writes.map((write) => [write.type, write.title]), [["issue", "Broken link"], ["issue", "Slow page"]]);
    assert.deepEqual(Object.keys(r.publication.issues).sort(), ["link:docs-a", "perf:home"]);
    assert.ok(!f.calls.some((call) => /\/(issues|pulls)\/\d+/.test(call.path)), JSON.stringify(f.calls));
    const [one] = requests(), { context } = one;
    assert.deepEqual(context.input, { kind: "tick", triggerKey: "2026-10-21T12:00:00.000Z", start: "2026-10-21T06:00:00.000Z", end: "2026-10-21T12:00:00.000Z" });
    assert.equal(context.action, "error_sweep"); assert.equal(context.reason, "schedule tick 2026-10-21T12:00:00.000Z");
    assert.equal(context.item.number, 0); assert.equal(context.workspace.mainSha, tip); assert.equal(context.files.history, undefined);
    assert.deepEqual(context.diffPaths, []); assert.equal(context.commentRevisions.length, 0);
    assert.equal(await poll("2026-10-21T18:00:00Z"), 1);
    const second = await success();
    assert.equal(second.publication.status, "published"); assert.equal(f.writes.length, 2);
    assert.deepEqual(Object.keys(second.publication.issues).sort(), ["link:docs-a", "perf:home"]);
    const later = requests().findLast((request) => request.context.input.triggerKey === "2026-10-21T18:00:00.000Z").context;
    assert.deepEqual(later.input, { kind: "tick", triggerKey: "2026-10-21T18:00:00.000Z", start: "2026-10-21T12:00:00.000Z", end: "2026-10-21T18:00:00.000Z" });
    const history = readFileSync(later.files.history, "utf8");
    assert.match(history, /## 2026-10-21T12:00:00\.000Z/); assert.match(history, /link:docs-a/);
    assert.equal(all(s.items).length, 0); assert.equal(all(s.subjects).length, 2); assert.equal(all(s.runs).length, 2);
  } },
  store_audit: { title: "a scheduled store audit runs the browser from the workflow's budget with the site map, the audit's own baselines and known breakages, keeps its Lighthouse, baselines and alerts apart from the main-change review, and posts the agent's first line as the root, one reply with the findings and the Lighthouse table, the verdict reaction and a report file, without posting twice on a retry", configure: [configureMainStorefront, (config) => { config.storefront.auditPaths = ["/pages/about"]; Object.assign(config.workflows.store_audit, { enabled: true, config: { ...config.workflows.store_audit.config, channel: "C0123456789" } }); }], run: async () => {
    const { fakes, scored, state } = await mainStorefront();
    const { pollSchedules } = await f.app("schedule-source.ts"), { config: live } = await f.app("config.ts"), site = "https://shop.example.test", channel = "C0123456789", S = storefrontScores;
    const tip = git(resolve("remote.git"), "rev-parse", "main"), first = "2026-10-21T13:15:00.000Z", next = "2026-10-22T13:15:00.000Z";
    const posts = () => f.slack.calls.filter((call) => call.method === "chat.postMessage"), reactions = () => f.slack.calls.filter((call) => call.method === "reactions.add");
    const audits = () => f.requests.filter((request) => request.context.action === "store_audit"), json = (path) => JSON.parse(state(path));
    const tick = async (at) => { f.reset(0, "normal"); assert.equal(await pollSchedules(undefined, new Date(at)), 1); };
    mkdirSync("data/storefront", { recursive: true }); writeFileSync("data/storefront/site.md", "Site map\n- `/products/<handle>`: product page\n");
    assert.equal(await pollSchedules(undefined, new Date("2026-10-21T08:00:00Z")), 0);

    scored();
    f.script = [{ name: "browser", args: { action: "goto", url: site + "/" } }, { name: "browser", args: { action: "screenshot", viewport: "desktop", fullPage: true } },
      { name: "browser", args: { action: "screenshot", viewport: "mobile", fullPage: true } }, { name: "browser", args: { action: "goto", url: site + "/cart" } },
      "Your store is healthy today & all 2 pages were checked <0 problems>.\n• `/cart` mobile: the cart lists the product with its price.\n\n## Checked\n- `/` and `/cart` on both devices.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete"];
    await tick("2026-10-21T13:15:00Z");
    const r1 = await success(), [one] = audits(), files = one.context.files;
    assert.equal(audits().length, 5); assert.equal(f.row(s.tasks, r1.taskId).status, "completed"); assert.equal(r1.mainSha, tip);
    assert.deepEqual(one.context.input, { kind: "tick", triggerKey: first, start: "2026-10-20T13:15:00.000Z", end: first });
    assert.deepEqual(JSON.parse(readFileSync(files.storefront, "utf8")), { liveUrl: site + "/", devices: ["desktop", "mobile"], confirmationRuns: 1, auditPaths: ["/pages/about"], knownBreakages: [] });
    assert.equal(readFileSync(files.siteMap, "utf8"), "Site map\n- `/products/<handle>`: product page\n"); assert.deepEqual([files.baselines, files.history], [undefined, undefined]);
    assert.equal(one.context.rootInstructions, live.workflows.store_audit.config.rootInstructions); assert.match(one.context.rootInstructions, /^One sentence for a non-technical reader/);
    assert.deepEqual(one.request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), ["read", "grep", "find", "ls", "browser"]); assert.match(one.text, /# Scheduled store audit/);
    assert.match(one.request.tools.find((tool) => tool.function.name === "browser").function.description, /At most 200 actions and 2700 seconds per session/);
    assert.deepEqual(fakes.visits, [site + "/", site + "/cart"]);
    const m1 = { "first-contentful-paint": 1.8, "largest-contentful-paint": 3.1, "total-blocking-time": 210, "cumulative-layout-shift": 0.05, "speed-index": 2.9 };
    assert.deepEqual(json("audits/lighthouse.json"), { mobile: { sha: tip, scores: S(60, 90, 96, 100), metrics: m1 }, desktop: { sha: tip, scores: S(90, 95, 100, 100), metrics: m1 } });
    assert.ok(!existsSync("data/storefront/lighthouse.json") && !existsSync("data/storefront/baselines") && !existsSync("data/storefront/alerts.json"), "the main-change review's state is untouched");
    assert.deepEqual(json("audits/baselines/index.json"), { home: { url: site + "/", devices: { desktop: tip, mobile: tip } } }); assert.equal(state("audits/baselines/home/mobile.png"), "png / 390 v1");
    assert.deepEqual(json("audits/alerts.json"), {});
    assert.ok(state(`audits/${first}.md`).startsWith(`## Store audit of ${first}\n\nLighthouse and the screenshots belong to \`main\` at ${tip}.\n\nYour store is healthy today & all 2 pages were checked <0 problems>.\n`));
    assert.ok(state(`audits/${first}.md`).includes("## Checked") && state(`audits/${first}.md`).includes("### Lighthouse"));
    assert.equal(posts().length, 2); const [root, reply] = posts(), [thread] = all(s.slackThreads), rootText = "Your store is healthy today &amp; all 2 pages were checked &lt;0 problems&gt;.";
    assert.deepEqual(root.body, { channel, unfurl_links: false, unfurl_media: false, link_names: false, text: rootText, blocks: [{ type: "section", text: { type: "mrkdwn", text: rootText } }] });
    assert.deepEqual({ channel: thread.channel, ts: thread.ts, subject: thread.subjectId }, { channel, ts: reply.body.thread_ts, subject: f.row(s.tasks, r1.taskId).subjectId });
    assert.equal(reply.body.text, "• `/cart` mobile: the cart lists the product with its price.\n• Lighthouse mobile (2 runs, no previous run): Performance 60, Accessibility 90, Best Practices 96, SEO 100; FCP 1.8 s, LCP 3.1 s, TBT 210 ms, CLS 0.05, Speed Index 2.9 s\n• Lighthouse desktop (2 runs, no previous run): Performance 90, Accessibility 95, Best Practices 100, SEO 100; FCP 1.8 s, LCP 3.1 s, TBT 210 ms, CLS 0.05, Speed Index 2.9 s");
    assert.deepEqual(reply.body.blocks.map((block) => block.type), ["rich_text", "table", "context"]); assert.ok(!JSON.stringify(reply.body).includes("github.com"));
    assert.deepEqual(reply.body.blocks[1].rows.slice(0, 3).map((row) => row.map((cell) => cell.text)), [["Lighthouse", "Mobile", "Desktop"], ["Runs", "2", "2"], ["Performance", "60", "90"]]);
    assert.deepEqual(reactions().map((call) => [call.body.channel, call.body.timestamp, call.body.name]), [[channel, thread.ts, "white_check_mark"]]);
    assert.equal(r1.result.verdict, "clean"); assert.equal(r1.publication.status, "published"); assert.equal(r1.publication.slackReplyTs, r1.publication.storefrontReplyTs); assert.equal(r1.publication.slackReaction, "white_check_mark");

    scored([S(0.64, 0.9, 0.96, 1), S(0.64, 0.9, 0.96, 1)], [S(0.9, 0.95, 1, 1), S(0.9, 0.95, 1, 1)]);
    f.script = [{ name: "browser", args: { action: "goto", url: site + "/" } },
      "The store has 1 problem today: the checkout does not open (2 pages checked).\n\n## Checked\n- `/`.\nSCRAT_ISSUE_BEGIN\ntitle: Checkout does not open\nfingerprint: cart:checkout\n\nThe checkout button did nothing on mobile three times.\nSCRAT_ISSUE_END\nSCRAT_VERDICT: breaking\nSCRAT_STATUS: complete"];
    await tick("2026-10-22T13:15:00Z");
    f.slack.reactionFail = ["service_unavailable"];
    const failed = await run(); assert.ok(failed.error); assert.equal(failed.stage, "publishing");
    assert.ok(failed.publication.slackReplyTs); assert.equal(failed.publication.slackReplyTs, failed.publication.storefrontReplyTs); assert.equal(failed.publication.slackReaction, undefined);
    const used = f.requests.length, sent = posts().length; tasks.retryTask(failed.taskId);
    const r2 = await success();
    assert.equal(f.requests.length, used, "the retry runs no new session"); assert.equal(posts().length, sent, "the retry posts no new root or reply"); assert.equal(sent, 4);
    const second = all(s.slackThreads).find((row) => row.subjectId === f.row(s.tasks, r2.taskId).subjectId), later = audits().findLast((request) => request.context.input.end === next).context;
    assert.deepEqual(reactions().slice(1).map((call) => [call.body.timestamp, call.body.name]), [[second.ts, "large_red_square"], [second.ts, "large_red_square"]]);
    assert.equal(r2.publication.slackReaction, "large_red_square"); assert.equal(r2.result.verdict, "breaking");
    const [secondRoot, secondReply] = posts().slice(2);
    assert.deepEqual([secondRoot.body.thread_ts, secondReply.body.thread_ts], [undefined, second.ts]); assert.equal(secondRoot.body.text, "The store has 1 problem today: the checkout does not open (2 pages checked).");
    assert.match(secondReply.body.text, /^• New breakage `cart:checkout`: Checkout does not open\n• Lighthouse mobile \(2 runs\): Performance 64 \(\+4\), Accessibility 90 \(±0\)/); assert.match(secondReply.body.text, /• Lighthouse desktop \(2 runs\): Performance 90 \(±0\)/);
    assert.deepEqual(secondReply.body.blocks.map((block) => block.type), ["rich_text", "table"]);
    const baselines = JSON.parse(readFileSync(later.files.baselines, "utf8")); assert.deepEqual(Object.keys(baselines.pages), ["home"]); assert.equal(baselines.pages.home.sha, tip.slice(0, 7));
    assert.equal(readFileSync(resolve(baselines.baselinesDir, baselines.pages.home.devices.mobile), "utf8"), "png / 390 v1", "the audit reads its own previous screenshots");
    assert.match(readFileSync(later.files.history, "utf8"), /## 2026-10-21T13:15:00\.000Z, \S+, complete\n\nYour store is healthy today & all 2 pages were checked <0 problems>\./);
    assert.deepEqual(json("audits/alerts.json"), { "cart:checkout": { title: "Checkout does not open", sha: tip } }); assert.equal(json("audits/lighthouse.json").mobile.scores.performance, 64);
    assert.equal(json("audits/baselines/index.json").home.devices.mobile, tip, "a run that is not clean keeps the baselines");
    assert.ok(state(`audits/${next}.md`).includes("### Confirmed breakage\n\n- **Checkout does not open** (`cart:checkout`, new on this commit)")); assert.ok(existsSync(`data/storefront/audits/${first}.md`));
    assert.ok(!existsSync("data/storefront/lighthouse.json")); assert.equal(all(s.slackThreads).length, 2);
  } },
  store_changes: { title: "the Shopify admin source seeds silently, reports a watched metafield change once after the quiet window with its before and after, the admin log line and its page, ignores app, unwatched and ignored metafields, skips metaobjects while their scope is denied, and its review posts the summary as the root and the verdict as the reply without Lighthouse", seed: seedStoreTheme, configure: [configureMainStorefront, (config) => { config.storefront.changes.ignoreMetafields = ["custom.skipped"]; Object.assign(config.workflows.review_store_change, { enabled: true, config: { ...config.workflows.review_store_change.config, channel: "C0123456789" } }); }], run: async () => {
    const { fakes, state } = await mainStorefront();
    const { pollStoreChanges } = await f.app("store-changes.ts"), { GitHubRepository } = await f.app("github.ts"), { config: live } = await f.app("config.ts"), { admin } = f.loggie, site = "https://shop.example.test", minute = 60_000, t0 = Date.parse("2026-10-30T12:00:00Z");
    await new GitHubRepository(live.github.repository).fetchBranch("main");
    const poll = (minutes) => pollStoreChanges(undefined, new Date(t0 + minutes * minute)), reviews = () => all(s.tasks).filter((task) => task.action === "review_store_change");
    const meta = (namespace, key, value) => ({ namespace, key, value }), gid = "gid://shopify/Product/1", key = new Date(t0 + 10 * minute).toISOString();
    const product = (nodes) => ({ id: gid, handle: "a-shirt", title: "A shirt", status: "ACTIVE", descriptionHtml: "<p>Soft</p>", templateSuffix: null, onlineStoreUrl: site + "/products/a-shirt", metafields: { nodes } });
    const draft = (value) => ({ ...product([meta("custom", "watched", value)]), id: "gid://shopify/Product/2", handle: "a-draft", status: "DRAFT", onlineStoreUrl: null });
    admin.roots.products = [product([meta("custom", "watched", "one"), meta("custom", "skipped", "x"), meta("custom", "unlisted", "x"), meta("okendo", "summary", "1")]), draft("a")];
    admin.roots.shop = [meta("custom", "watched", "banner")];
    admin.denied.add("metaobjectDefinitions");
    assert.equal(await poll(0), 0); assert.equal(await poll(5), 0); assert.equal(reviews().length, 0, "the first poll seeds and queues nothing");
    admin.roots.products = [{ ...product([meta("custom", "watched", "two"), meta("custom", "skipped", "y"), meta("custom", "unlisted", "y"), meta("okendo", "summary", "2")]), descriptionHtml: "<p>Softer</p>" }, draft("b")];
    admin.roots.events = [{ message: '<a href="/admin/staff/1">Jane Doe</a>  updated product A shirt', subjectId: gid }];
    assert.equal(await poll(7), 0, "a poll inside pollMinutes reads nothing");
    assert.equal(await poll(10), 0); assert.equal(await poll(15), 0); assert.equal(await poll(19), 0); assert.equal(reviews().length, 0, "nothing is queued during the quiet window");
    assert.equal(await poll(20), 1); assert.equal(await poll(25), 0); assert.equal(await poll(60), 0); assert.equal(reviews().length, 1);
    const [task] = reviews(), batch = JSON.parse(state(`changes/batches/${key}.json`)), summary = "Store data update in Shopify admin: product `a-shirt` had `descriptionHtml` edited; product `a-shirt` had `custom.watched` edited (Jane Doe updated product A shirt).";
    assert.deepEqual(task.input, { source: "shopify", kind: "store_change", triggerKey: key }); assert.equal(task.reason, summary);
    assert.deepEqual(batch.changes.map(({ field, before, after, paths, events }) => [field, before, after, paths, events]), [
      ["descriptionHtml", "<p>Soft</p>", "<p>Softer</p>", ["/products/a-shirt"], ["Jane Doe updated product A shirt"]],
      ["metafield:custom.watched", "one", "two", ["/products/a-shirt"], ["Jane Doe updated product A shirt"]],
    ]);
    assert.deepEqual(batch.pages, [site + "/products/a-shirt"]);
    assert.ok(f.loggie.requests.every((request) => request.key === f.loggie.key));

    f.script = [{ name: "browser", args: { action: "goto", url: site + "/products/a-shirt" } }, { name: "browser", args: { action: "screenshot", viewport: "mobile", fullPage: true } },
      "The shirt page shows the new details.\n• `/products/a-shirt` mobile: the details list shows the new text.\n\n## Checked\n- `/products/a-shirt`.\nSCRAT_VERDICT: clean\nSCRAT_STATUS: complete"];
    const run = await success(), [request] = f.requests.filter((entry) => entry.context.action === "review_store_change"), files = request.context.files;
    assert.equal(run.result.verdict, "clean"); assert.deepEqual(request.context.input, { kind: "store_change", triggerKey: key });
    assert.deepEqual(JSON.parse(readFileSync(files.storeChanges, "utf8")).pages, batch.pages); assert.deepEqual(JSON.parse(readFileSync(files.storefront, "utf8")).knownBreakages, []);
    assert.deepEqual(fakes.visits, [site + "/products/a-shirt"]); assert.deepEqual(fakes.audits, [], "a content review runs no Lighthouse");
    const [root, reply] = f.slack.calls.filter((call) => call.method === "chat.postMessage"), [thread] = all(s.slackThreads);
    assert.equal(root.body.text, summary); assert.equal(root.body.channel, "C0123456789"); assert.equal(reply.body.thread_ts, thread.ts);
    assert.equal(reply.body.text, "The shirt page shows the new details.\n• `/products/a-shirt` mobile: the details list shows the new text.");
    assert.deepEqual(JSON.parse(state("baselines/index.json")), { "products_a-shirt": { url: site + "/products/a-shirt", devices: { mobile: run.mainSha } } });
    assert.ok(!existsSync("data/storefront/lighthouse.json"));

    // Verify bounded concurrency across listings + shop + metaobjects never exceeds storefront.changes.concurrency
    admin.denied.delete("metaobjectDefinitions");
    admin.roots.metaobjectDefinitions = Array.from({ length: 6 }, (_, i) => ({ type: `custom_type_${i}` }));
    admin.roots.metaobjects = [];
    live.storefront.changes.concurrency = 2;
    const prevFetch = globalThis.fetch;
    let inFlight = 0, maxInFlight = 0;
    globalThis.fetch = async (url, init) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await prevFetch(url, init);
      } finally { inFlight--; }
    };
    try {
      await poll(120);
      assert.ok(maxInFlight >= 2, `store_changes should parallelize queries: maxInFlight=${maxInFlight}`);
      assert.ok(maxInFlight <= 2, `shared limiter must cap nested listings + metaobjects at concurrency=2: got ${maxInFlight}`);
    } finally { globalThis.fetch = prevFetch; }
  } },
  storefront_preview: { title: "an enabled storefront gives each Scrat PR review one recorded MAIN duplicate through Loggie, adopts a duplicate whose reply was lost, resumes its processing wait, replaces a theme that vanished, reuses it and deletes it when the PR closes, retrying a failed delete; a refused Loggie call only logs, and a disabled storefront or a human PR makes no Loggie call", configure: [(config) => { Object.assign(config.storefront, { store: "fixture.myshopify.com", publicHost: "shop.example.test" }); Object.assign(config.storefront.preview, { processingPollSeconds: 1, filesPageSize: 2 }); }], run: async () => {
    const { config: live } = await f.app("config.ts"), { loggie } = await f.app("loggie.ts"), { childEnvironment, containsSecret } = await f.app("secrets.ts");
    const fields = (from = 0) => f.loggie.requests.slice(from).map((request) => request.field), previews = () => all(s.themePreviews);
    const named = (name) => [...f.loggie.themes.values()].filter((theme) => theme.name === name);
    const pr = (number) => f.prs.find((entry) => entry.number === number), review = async (number) => { tasks.enqueueManualTasks("review_pr", [String(number)]); return success(); };
    const logged = async (event, work) => { const lines = captureLogs(); try { await work(); } finally { restoreLogs(); } return lines.find((line) => line.event === event); };
    const failure = (work) => logged("storefront.preview_failed", work);
    await implement(1); await route(); await success();
    branchOff("human-7", "src/app.ts", "export const value = 7;\n"); f.addPr(7, "human-7", "human"); await route();
    pr(7).state = "closed"; await route();
    assert.equal(f.loggie.requests.length, 0, "a disabled storefront makes no Loggie call");
    live.storefront.enabled = true;
    f.loggie.restricted.add("themeDuplicate");
    const restricted = await failure(async () => assert.equal((await review(201)).publication.status, "published"));
    assert.equal(restricted.err.code, "ENDPOINT_RESTRICTED"); assert.equal(restricted.err.status, 403); assert.equal(restricted.number, 201);
    assert.deepEqual(fields(), ["themes", "themeDuplicate"]);
    const [intent] = previews();
    assert.deepEqual({ count: previews().length, name: intent.name, themeGid: intent.themeGid, pullRequestNumber: intent.pullRequestNumber }, { count: 1, name: "scrat/pr-201", themeGid: null, pullRequestNumber: 201 });
    f.loggie.restricted.clear(); f.loggie.lostDuplicate = true; f.loggie.processingPolls = 5; live.storefront.preview.processingWaitSeconds = 1;
    let from = f.loggie.requests.length;
    const lost = await failure(() => review(201));
    assert.equal(lost.err.code, "LOGGIE_HTTP"); assert.equal(lost.err.status, 502);
    assert.deepEqual(fields(from), ["themes", "themes", "themeDuplicate"]);
    assert.equal(f.row(s.themePreviews, intent.id).themeGid, null); assert.equal(named("scrat/pr-201").length, 1);
    from = f.loggie.requests.length;
    const waiting = await failure(() => review(201));
    assert.match(waiting.err.message, /still processing after 1s/);
    assert.deepEqual(fields(from).slice(0, 2), ["themes", "theme"]); assert.ok(!fields(from).includes("themeDuplicate"), "the theme behind the lost reply is adopted by name, not duplicated again");
    const [orphan] = named("scrat/pr-201"), adopted = f.row(s.themePreviews, intent.id);
    assert.deepEqual({ themeGid: adopted.themeGid, themeId: adopted.themeId, baseline: adopted.baseline, count: named("scrat/pr-201").length }, { themeGid: orphan.id, themeId: Number(orphan.id.split("/").at(-1)), baseline: null, count: 1 });
    f.loggie.themes.delete(orphan.id);
    assert.match((await failure(() => review(201))).err.message, /is gone from the store/);
    assert.ok(f.row(s.themePreviews, intent.id).deletedAt, "a theme that vanished while settling leaves its row deleted");
    f.loggie.processingPolls = 1; live.storefront.preview.processingWaitSeconds = 300;
    from = f.loggie.requests.length;
    assert.equal(await failure(() => review(201)), undefined);
    assert.deepEqual(fields(from), ["themes", "themeDuplicate", "theme", "theme", "theme", "theme", "theme"], "the next review duplicates afresh, waits for processing, lists the files page by page and checks the role before syncing");
    const preview = previews().find((row) => !row.deletedAt), theme = f.loggie.themes.get(preview.themeGid);
    assert.equal(previews().length, 2); assert.equal(preview.subjectId, intent.subjectId); assert.equal(preview.themeId, Number(preview.themeGid.split("/").at(-1)));
    assert.equal(theme.name, "scrat/pr-201"); assert.equal(theme.role, "UNPUBLISHED");
    assert.deepEqual(preview.baseline, Object.fromEntries(f.loggie.themes.get(f.loggie.mainTheme).files));
    const settled = f.loggie.requests.length;
    await review(201);
    branchOff("human-8", "src/app.ts", "export const value = 8;\n"); f.addPr(8, "human-8", "human"); await route();
    const human = f.row(s.tasks, (await success()).taskId);
    assert.equal(all(s.items).find((item) => item.id === human.subjectId).payload.number, 8);
    assert.equal(f.loggie.requests.length, settled, "a recorded preview is reused and a human PR gets none");
    f.loggie.processingPolls = 0;
    const implemented = await implement(2); await route(); await success();
    const other = previews().find((row) => row.pullRequestNumber === 202);
    assert.ok(other.baseline);
    pr(201).state = "closed"; await route();
    assert.ok(f.row(s.themePreviews, preview.id).deletedAt);
    assert.equal(f.loggie.themes.has(preview.themeGid), false); assert.ok(f.loggie.themes.has(f.loggie.mainTheme)); assert.ok(f.loggie.themes.has(other.themeGid));
    f.loggie.restricted.add("themeDelete");
    const failed = await logged("storefront.delete_failed", async () => { pr(202).state = "closed"; await route(); });
    assert.equal(failed.err.code, "ENDPOINT_RESTRICTED"); assert.equal(f.row(s.themePreviews, other.id).deletedAt, null);
    assert.ok(f.row(s.workspaces, implemented.workspaceId).removedAt, "a failed preview delete does not hold back the workspace cleanup");
    f.loggie.restricted.clear(); f.loggie.themes.delete(other.themeGid);
    from = f.loggie.requests.length; await route();
    assert.deepEqual(fields(from), ["theme"], "the next sync retries the delete and accepts a theme that is already gone");
    assert.ok(f.row(s.themePreviews, other.id).deletedAt);
    from = f.loggie.requests.length; await route();
    assert.equal(f.loggie.requests.length, from, "a deleted preview is not deleted again");
    const recorded = new Set(previews().map((row) => row.themeGid));
    for (const { field, variables, key } of f.loggie.requests) {
      assert.equal(key, f.loggie.key);
      if (field === "themeDuplicate") assert.equal(variables.id, f.loggie.mainTheme);
      if (field === "theme" || field === "themeDelete") assert.ok(recorded.has(variables.id), "Scrat reads and deletes only themes it recorded");
    }
    assert.equal("LOGGIE_API_KEY" in childEnvironment(), false); assert.ok(containsSecret("key " + f.loggie.key));
    assert.ok(f.requests.every(({ request }) => !JSON.stringify(request).includes(f.loggie.key) && !JSON.stringify(request).includes("/api/proxy/")), "the agent never sees the key or the proxy");
    assert.ok(!JSON.stringify(all(s.events)).includes(f.loggie.key));
    await assert.rejects(loggie("themePublish", "mutation Publish($id: ID!) { themePublish(id: $id) { theme { id } } }", { id: preview.themeGid }), { code: "ENDPOINT_RESTRICTED", status: 403 });
    const wrong = process.env.LOGGIE_API_KEY = "wrong-" + "k".repeat(24);
    await assert.rejects(loggie("themes", "query { themes(first: 1) { nodes { id } } }"), (error) => error.code === "UNAUTHORIZED" && error.status === 401 && !error.message.includes(wrong));
  } },
  storefront_sync: { title: "a Scrat PR's theme changes reach its preview as checksum-verified batched uploads and deletions, a head move syncs only the delta and resends files that did not verify, a mismatch marks the preview unavailable in the sticky comment and the deployment, a theme gone from the store is replaced, an App without deployments loses only the deployment, and review agents get the preview link, theme ID and head as the storefront file", seed: seedTheme, configure: [configureStorefront], run: async () => {
    const md5 = f.loggie.md5, png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x10]), layout = "<html>{{ content_for_layout }}<footer></footer></html>\n";
    f.loggie.setLive(Object.fromEntries(Object.entries(themeFiles).filter(([path]) => path !== "README.md")));
    f.loggie.processingPolls = 0; writeFileSync("logo.png", png);
    f.script = [{ name: "bash", args: { command: `printf '${layout.trimEnd()}\\n' > layout/theme.liquid && cp ${resolve("logo.png")} assets/logo.png && rm templates/index.json && printf 'changed\\n' > README.md` } }];
    await implement(1); f.script = undefined;
    const pr = f.prs[0], head = () => pr.head.sha, previews = () => all(s.themePreviews), live = () => previews().find((row) => !row.deletedAt);
    const sent = (field, from) => f.loggie.requests.slice(from).filter((request) => request.field === field).map((request) => request.variables.files);
    const names = (batches) => batches.map((batch) => batch.map((file) => file.filename));
    const previewComments = () => f.botComments(201).filter((comment) => comment.body.endsWith("<!-- scrat-preview -->"));
    const states = () => f.deployments.map(({ ref, environment, statuses }) => ({ ref, environment, states: statuses.map((status) => status.state) }));
    const storefront = (run) => {
      const file = resolve("data/runs", run.id, "storefront.json");
      assert.ok(f.requests.some((request) => request.context.files?.storefront === file), "the review agent is given the storefront file");
      return JSON.parse(readFileSync(file, "utf8"));
    };
    const reviewed = async () => { await route(); const lines = captureLogs(); try { return { run: await success(), lines }; } finally { restoreLogs(); } };
    f.faults.permissions.add("deployments");
    const first = await reviewed(), preview = live(), theme = f.loggie.themes.get(preview.themeGid), url = `https://shop.example.test/?preview_theme_id=${preview.themeId}`;
    assert.deepEqual(sent("themeFilesUpsert", 0), [[
      { filename: "assets/logo.png", body: { type: "BASE64", value: png.toString("base64") } },
      { filename: "layout/theme.liquid", body: { type: "TEXT", value: layout } },
    ]], "only the PR's theme files are uploaded, binaries as BASE64");
    assert.deepEqual(sent("themeFilesDelete", 0), [["templates/index.json"]]);
    assert.deepEqual(Object.fromEntries(theme.files), { "layout/theme.liquid": md5(layout), "assets/app.css": md5(themeFiles["assets/app.css"]), "config/settings_data.json": md5(themeFiles["config/settings_data.json"]), "assets/logo.png": md5(png) });
    assert.deepEqual({ headSha: preview.headSha, problems: preview.problems, deploymentId: preview.deploymentId }, { headSha: head(), problems: [], deploymentId: null });
    assert.equal(first.lines.find((line) => line.event === "storefront.deployment_failed")?.err.status, 422);
    assert.equal(f.deployments.length, 0, "an App without the deployments permission loses only the deployment");
    const [comment] = previewComments();
    assert.equal(previewComments().length, 1); assert.ok([url, String(preview.themeId), head()].every((text) => comment.body.includes(text)));
    assert.deepEqual(storefront(first.run), { url, themeId: preview.themeId, headSha: head(), available: true, problems: [], liveUrl: "https://shop.example.test/", devices: ["desktop", "mobile"], confirmationRuns: 1, regressionMaxGrade: "C" });
    f.faults.permissions.clear(); f.loggie.wrongMd5.add("assets/app.css");
    let from = f.loggie.requests.length;
    pushFile(pr.head.ref, "assets/app.css", "body { color: red; }\n");
    const second = await reviewed(), secondHead = head(), mismatch = ["`assets/app.css` does not match the commit"];
    assert.deepEqual(names(sent("themeFilesUpsert", from)), [["assets/app.css"]], "a head move uploads only what changed"); assert.deepEqual(sent("themeFilesDelete", from), []);
    assert.deepEqual({ headSha: live().headSha, problems: live().problems }, { headSha: secondHead, problems: mismatch });
    assert.equal(previewComments().length, 1); assert.equal(previewComments()[0].id, comment.id);
    assert.match(previewComments()[0].body, new RegExp(`preview unavailable for ${secondHead}.*\\n\\n- \`assets/app\\.css\` does not match the commit`, "s"));
    assert.deepEqual(states(), [{ ref: secondHead, environment: "shopify-preview", states: ["failure"] }]);
    assert.deepEqual(storefront(second.run), { url: null, themeId: preview.themeId, headSha: secondHead, available: false, problems: mismatch, liveUrl: "https://shop.example.test/", devices: ["desktop", "mobile"], confirmationRuns: 1, regressionMaxGrade: "C" });
    f.loggie.wrongMd5.clear(); from = f.loggie.requests.length;
    pushFile(pr.head.ref, "snippets/badge.liquid", "<span>new</span>\n");
    const third = await reviewed();
    assert.deepEqual(sent("themeFilesUpsert", from), [[
      { filename: "assets/app.css", body: { type: "TEXT", value: "body { color: red; }\n" } },
      { filename: "snippets/badge.liquid", body: { type: "TEXT", value: "<span>new</span>\n" } },
    ]], "a file that did not verify is sent again with the new change");
    assert.deepEqual(live().problems, []);
    assert.deepEqual(states(), [{ ref: secondHead, environment: "shopify-preview", states: ["failure", "inactive"] }, { ref: head(), environment: "shopify-preview", states: ["success"] }]);
    assert.equal(f.deployments[1].statuses[0].environmentUrl, url); assert.ok(f.deployments.every((deployment) => deployment.statuses.every((status) => status.autoInactive === false)));
    assert.ok(previewComments().length === 1 && [url, head()].every((text) => previewComments()[0].body.includes(text)));
    assert.equal(storefront(third.run).available, true);
    from = f.loggie.requests.length;
    tasks.enqueueManualTasks("review_pr", ["201"]); await success();
    assert.equal(f.loggie.requests.length, from, "an unchanged head syncs nothing"); assert.equal(f.deployments.length, 2);
    f.loggie.themes.delete(preview.themeGid);
    pushFile(pr.head.ref, "snippets/badge.liquid", "<span>newer</span>\n");
    const gone = await reviewed();
    assert.match(gone.lines.find((line) => line.event === "storefront.preview_failed").err.message, /is gone from the store/);
    assert.ok(f.row(s.themePreviews, preview.id).deletedAt, "a reused preview whose theme is gone is marked deleted before any upload");
    assert.match(previewComments()[0].body, new RegExp(`preview unavailable for ${head()}.*is gone from the store`, "s"));
    assert.deepEqual(f.deployments.map(({ statuses }) => statuses.at(-1).state), ["inactive", "inactive", "failure"], "the dead link is replaced by a failure deployment");
    from = f.loggie.requests.length;
    tasks.enqueueManualTasks("review_pr", ["201"]); await success();
    const replacement = live();
    assert.notEqual(replacement.themeGid, preview.themeGid); assert.deepEqual(replacement.problems, []);
    assert.deepEqual(names(sent("themeFilesUpsert", from)), [["assets/app.css", "assets/logo.png"], ["layout/theme.liquid", "snippets/badge.liquid"]], "a new preview gets every PR file, in batches of uploadBatch");
    assert.deepEqual(sent("themeFilesDelete", from), [["templates/index.json"]]);
    assert.ok(previewComments().length === 1 && previewComments()[0].body.includes(String(replacement.themeId)));
    pr.state = "closed"; await route();
    assert.ok(previews().every((row) => row.deletedAt)); assert.equal(f.loggie.themes.has(replacement.themeGid), false);
    assert.equal(previewComments().length, 1); assert.match(previewComments()[0].body, /Shopify preview removed:.*was deleted when this PR closed/);
    assert.deepEqual(f.deployments.map(({ statuses }) => statuses.at(-1).state), ["inactive", "inactive", "inactive", "inactive"], "every deployment of the PR ends inactive");
    const recorded = new Set(previews().map((row) => row.themeGid));
    for (const { field, variables } of f.loggie.requests) if (field === "themeFilesUpsert" || field === "themeFilesDelete") assert.ok(recorded.has(variables.themeId), "files are written only to recorded themes");
  } },
  storefront_sync_faults: { title: "a file the PR stops changing is copied back from the live theme (text or URL body), uploads are cut by bytes as well as count, a failed batch or a Shopify refusal marks the head unavailable and the same head is retried until it verifies, a published preview is neither written nor deleted, and closing the PR leaves every deployment inactive", seed: () => { seedTheme(); writeFileSync("seed/assets/hero.png", heroPng); }, configure: [configureStorefront, (config) => { config.storefront.preview.uploadBatchBytes = 36; }], run: async () => {
    const md5 = f.loggie.md5, png = heroPng, changedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe, 0xfd, 0xfc]);
    const liveFiles = { ...Object.fromEntries(Object.entries(themeFiles).filter(([path]) => path !== "README.md")), "assets/hero.png": png };
    f.loggie.setLive(liveFiles); f.loggie.processingPolls = 0; writeFileSync("hero2.png", changedPng);
    f.script = [{ name: "bash", args: { command: `mkdir -p snippets && printf '{"current":{"pr":1}}\\n' > config/settings_data.json && printf '<p>old</p>\\n' > snippets/old.liquid && cp ${resolve("hero2.png")} assets/hero.png` } }];
    await implement(1); f.script = undefined;
    const pr = f.prs[0], head = () => pr.head.sha, live = () => all(s.themePreviews).find((row) => !row.deletedAt);
    const sent = (field, from) => f.loggie.requests.slice(from).filter((request) => request.field === field).map((request) => request.variables.files);
    const names = (batches) => batches.map((batch) => batch.map((file) => file.filename ?? file));
    const comment = () => { const found = f.botComments(201).filter((entry) => entry.body.endsWith("<!-- scrat-preview -->")); assert.equal(found.length, 1); return found[0].body; };
    const states = () => f.deployments.map(({ statuses }) => statuses.at(-1).state);
    const logged = async (work) => { const lines = captureLogs(); try { await work(); } finally { restoreLogs(); } return lines; };
    const reviewed = () => logged(async () => { await route(); await success(); });
    const again = () => logged(async () => { tasks.enqueueManualTasks("review_pr", ["201"]); await success(); });
    let from = f.loggie.requests.length;
    await reviewed();
    const preview = live(), theme = f.loggie.themes.get(preview.themeGid);
    assert.deepEqual(names(sent("themeFilesUpsert", from)), [["assets/hero.png"], ["config/settings_data.json", "snippets/old.liquid"]], "a batch closes before it would pass uploadBatchBytes");
    assert.deepEqual(preview.problems, []); assert.deepEqual(states(), ["success"]);
    const liveSettings = '{"current":{"live":2}}\n', livePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a, 0x0b, 0x0c]);
    f.loggie.setLive({ ...liveFiles, "config/settings_data.json": liveSettings, "assets/hero.png": livePng });
    pushFile(pr.head.ref, "config/settings_data.json", themeFiles["config/settings_data.json"]); pushFile(pr.head.ref, "assets/hero.png", png);
    pushFile(pr.head.ref, "snippets/new.liquid", "<p>old</p>\n"); pushFile(pr.head.ref, "snippets/old.liquid", null);
    f.loggie.restricted.add("themeFilesDelete");
    from = f.loggie.requests.length;
    const failed = await reviewed(), failedHead = head();
    assert.deepEqual(sent("themeFilesUpsert", from), [
      [{ filename: "assets/hero.png", body: { type: "BASE64", value: livePng.toString("base64") } }],
      [{ filename: "config/settings_data.json", body: { type: "TEXT", value: liveSettings } }, { filename: "snippets/new.liquid", body: { type: "TEXT", value: "<p>old</p>\n" } }],
    ], "reverted files are copied from the live theme, not the merge base, and a rename uploads the new path");
    assert.deepEqual(sent("themeFilesDelete", from), [["snippets/old.liquid"]], "a rename deletes the old path");
    assert.equal(theme.files.get("config/settings_data.json"), md5(liveSettings)); assert.equal(theme.files.get("assets/hero.png"), md5(livePng));
    assert.equal(failed.find((line) => line.event === "storefront.preview_failed").err.code, "ENDPOINT_RESTRICTED");
    assert.equal(live().synced["snippets/old.liquid"], "", "a batch is recorded as unverified before it is sent");
    assert.deepEqual({ headSha: live().headSha, problems: live().problems.length }, { headSha: failedHead, problems: 1 });
    assert.match(comment(), new RegExp(`preview unavailable for ${failedHead}.*The sync to this commit failed \\(Loggie refused themeFilesDelete with HTTP 403 ENDPOINT_RESTRICTED`, "s"));
    assert.deepEqual(states(), ["inactive", "failure"]);
    f.loggie.restricted.clear(); from = f.loggie.requests.length;
    await again();
    assert.deepEqual(sent("themeFilesUpsert", from), [], "verified files are not sent again"); assert.deepEqual(sent("themeFilesDelete", from), [["snippets/old.liquid"]]);
    assert.deepEqual(live().problems, []); assert.equal(theme.files.has("snippets/old.liquid"), false);
    assert.match(comment(), new RegExp(`synced to ${failedHead}`)); assert.deepEqual(states(), ["inactive", "inactive", "success"]);
    f.loggie.upsertErrors.add("sections/hero.liquid"); f.loggie.stuckDeletes.add("templates/index.json");
    pushFile(pr.head.ref, "sections/hero.liquid", "<section>hero</section>\n"); pushFile(pr.head.ref, "templates/index.json", null);
    await reviewed();
    const refusals = ["Shopify: sections/hero.liquid: Liquid syntax error", "`sections/hero.liquid` does not match the commit", "Shopify: templates/index.json could not be deleted", "`templates/index.json` is still in the theme"];
    assert.deepEqual(live().problems, refusals);
    assert.ok(refusals.every((problem) => comment().includes(`- ${problem}`))); assert.deepEqual(states(), ["inactive", "inactive", "inactive", "failure"]);
    f.loggie.upsertErrors.clear(); f.loggie.stuckDeletes.clear(); from = f.loggie.requests.length;
    await again();
    assert.deepEqual(names(sent("themeFilesUpsert", from)), [["sections/hero.liquid"]], "a head with problems is synced again on the next review");
    assert.deepEqual(sent("themeFilesDelete", from), [["templates/index.json"]]);
    assert.deepEqual(live().problems, []); assert.deepEqual(states(), ["inactive", "inactive", "inactive", "inactive", "success"]);
    from = f.loggie.requests.length;
    await again();
    assert.equal(f.loggie.requests.length, from, "a verified head is not synced again");
    theme.role = "MAIN";
    pushFile(pr.head.ref, "snippets/new.liquid", "<p>new</p>\n");
    from = f.loggie.requests.length;
    await reviewed();
    assert.deepEqual([...sent("themeFilesUpsert", from), ...sent("themeFilesDelete", from)], [], "a published preview is never written");
    assert.deepEqual(live().problems, [`theme \`scrat/pr-201\` (ID ${preview.themeId}) is no longer unpublished (role MAIN), so Scrat does not write to it`]);
    assert.match(comment(), /preview unavailable for .*is no longer unpublished \(role MAIN\)/s); assert.equal(states().at(-1), "failure");
    from = f.loggie.requests.length;
    pr.state = "closed"; f.deployments.pop();
    const closed = await logged(route);
    assert.ok(!closed.some((line) => line.event === "storefront.deployment_failed"), "a deployment GitHub no longer has counts as inactive");
    assert.deepEqual(f.loggie.requests.slice(from).map((request) => request.field), ["theme"], "a published preview is not deleted");
    assert.ok(f.loggie.themes.has(preview.themeGid)); assert.equal(closed.find((line) => line.event === "storefront.preview_kept").role, "MAIN");
    assert.match(comment(), /Shopify preview removed:.*is no longer unpublished \(role MAIN\), so Scrat left it in the store/s);
    assert.ok(states().every((state) => state === "inactive"), "every deployment of the PR ends inactive");
    assert.ok(all(s.themePreviews).every((row) => row.deletedAt && row.deploymentId === null));
    from = f.loggie.requests.length; await route();
    assert.equal(f.loggie.requests.length, from);
    for (const { field, variables } of f.loggie.requests) if (field === "themeFilesUpsert" || field === "themeFilesDelete") assert.equal(variables.themeId, preview.themeGid);
  } },
  storefront_site_map: { title: "the service poll queues no discovery while the storefront is off and one per missing or stale site map while it is on; the read-only session gets the storefront browser with its own budget and the live URL, its response is stored with its date as data/storefront/site.md and handed to later storefront reviews and to the next discovery after siteMapMaxAgeDays, once the file is gone, once the discovery skill changes or once a template is added on main (not when one is modified); an incomplete discovery stores nothing and is queued again only after siteMapRetryHours, one left queued when the storefront is turned off is refused, and a manifest listing browser alone gets the browser only in a review of a preview that matches the head", seed: seedTheme, configure: [configureStorefront], run: async () => {
    const { pollSiteMap } = await f.app("storefront-site.ts"), { pollSources } = await f.app("poll-sources.ts"), { config: live } = await f.app("config.ts");
    const day = 86_400_000, start = Date.parse("2026-10-25T00:00:00Z"), at = (iso, days = 0) => (Date.parse(iso) - start) / day + days, poll = (days) => pollSiteMap(undefined, new Date(start + days * day));
    const discoveries = () => all(s.tasks).filter((task) => task.action === "storefront_discover");
    const sessions = () => f.requests.filter((request) => request.context.action === "storefront_discover");
    const site = resolve("data/storefront/site.md"), written = () => all(s.sourceCursors).find((row) => row.action === "storefront_discover" && row.branch === "site_map")?.sha.split(" ")[0];
    const stored = (iso) => `Site map of https://shop.example.test/, written by Scrat on ${iso}.\n\n- \`/products/<handle>\`: product page with add to cart.\n`;
    const names = (request) => request.request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode"), panel = JSON.stringify(["read", "grep", "find", "ls", "git", "read_base"]);
    const reviewed = async () => { const from = f.requests.length; await route(); await success(); return f.requests.slice(from).filter((request) => request.context.action === "review_pr"); };
    f.loggie.processingPolls = 0;
    live.storefront.enabled = false;
    await pollSources();
    assert.equal(discoveries().length, 0, "the service poll queues no discovery while the storefront is off");
    live.storefront.enabled = true;
    await pollSources();
    assert.equal(discoveries().length, 1); assert.equal(await poll(0), 0, "a queued discovery is not queued again");
    const [task] = discoveries();
    assert.equal(await poll(at(task.createdAt, 2)), 0, "a queued discovery blocks another past siteMapRetryHours");
    assert.deepEqual(task.input, { source: "storefront", kind: "site_map", triggerKey: "none" });
    assert.deepEqual({ kind: f.row(s.subjects, task.subjectId).kind, key: f.row(s.subjects, task.subjectId).key, priority: task.priority }, { kind: "window", key: "storefront_discover:none", priority: 20 });
    const first = await success();
    assert.equal(first.publication.status, "published"); assert.ok(f.row(s.workspaces, first.workspaceId).removedAt);
    const [session] = sessions(), browser = session.request.tools.find((tool) => tool.function.name === "browser");
    assert.deepEqual(names(session), ["read", "grep", "find", "ls", "browser"]);
    assert.match(browser.function.description, /public https sites.*At most 80 actions and 1200 seconds per session/s);
    assert.match(JSON.stringify(session.request.messages.filter((m) => m.role === "system" || m.role === "developer")), /read\/search\/git and browser tools; do not modify files, implement a fix, or claim to have run shell commands, tests or live integrations; report only the browser checks you performed/);
    assert.match(session.text, /# Storefront site map.*Visit only URLs on the `liveUrl` host/s);
    assert.deepEqual(JSON.parse(readFileSync(session.context.files.storefront, "utf8")), { liveUrl: "https://shop.example.test/" });
    assert.equal(session.context.files.siteMap, undefined, "the first discovery has no previous map");
    const firstWritten = written();
    assert.equal(readFileSync(site, "utf8"), stored(firstWritten));
    assert.equal(await poll(at(firstWritten, 29)), 0, "a fresh map is kept");

    await implement(1);
    const pr = f.prs[0], review = await reviewed();
    assert.equal(review.at(-1).context.files.siteMap, resolve(dirname(review.at(-1).context.files.storefront), "site.md"));
    assert.equal(readFileSync(review.at(-1).context.files.siteMap, "utf8"), stored(firstWritten), "a later storefront review gets the stored map");
    assert.equal(JSON.parse(readFileSync(review.at(-1).context.files.storefront, "utf8")).liveUrl, "https://shop.example.test/");
    assert.equal(new Set(review.map((request) => `${request.request.model}/${request.consolidating}`)).size, 3);
    assert.ok(review.every((request) => names(request).includes("browser")), "every panel session reviewing a matching preview gets the browser");
    assert.match(review[0].request.tools.find((tool) => tool.function.name === "browser").function.description, /public https sites.*At most 80 actions and 1200 seconds per session/s);
    f.loggie.wrongMd5.add("snippets/badge.liquid"); pushFile(pr.head.ref, "snippets/badge.liquid", "<span>new</span>\n");
    const mismatched = await reviewed();
    assert.equal(JSON.parse(readFileSync(mismatched[0].context.files.storefront, "utf8")).available, false);
    assert.ok(mismatched.length && mismatched.every((request) => JSON.stringify(names(request)) === panel), "a preview that does not match the head gives no browser");
    f.loggie.wrongMd5.clear();
    branchOff("human-7", "assets/app.css", "body { color: blue; }\n"); f.addPr(7, "human-7", "human");
    const human = await reviewed();
    assert.ok(human.length && human.every((request) => request.context.item.number === 7 && request.context.files.storefront === undefined && JSON.stringify(names(request)) === panel), "a human PR gets no browser");

    assert.equal(await poll(at(firstWritten, 31)), 1);
    assert.equal(discoveries().at(-1).input.triggerKey, firstWritten);
    assert.equal(f.row(s.subjects, discoveries().at(-1).subjectId).key, `storefront_discover:${firstWritten}`);
    await success();
    assert.equal(readFileSync(sessions().at(-1).context.files.siteMap, "utf8"), stored(firstWritten), "the next discovery starts from the previous map");
    const secondWritten = written();
    assert.ok(secondWritten > firstWritten); assert.equal(readFileSync(site, "utf8"), stored(secondWritten));
    assert.equal(await poll(at(secondWritten, 1)), 0);
    const skill = resolve("app/workflows/storefront_discover/SKILL.md"), { GitHubRepository } = await f.app("github.ts");
    const pushMain = async (path, text) => { const sha = pushFile("main", path, text); await new GitHubRepository("fixture/project").fetchBranch("main"); return sha; };
    writeFileSync(skill, readFileSync(skill, "utf8") + "\nName the close control of each blocking overlay.\n");
    assert.equal(await poll(at(secondWritten, 1)), 1, "a changed discovery skill makes the map due");
    assert.match(discoveries().at(-1).reason, /^the discovery skill changed after the site map written /);
    await success();
    await pushMain("templates/index.json", "{\"sections\":{\"hero\":{}}}\n");
    assert.equal(await poll(at(written(), 1)), 0, "a template modified on main keeps the map");
    const added = await pushMain("templates/page.faq.json", "{\"sections\":{}}\n");
    assert.equal(await poll(at(written(), 1)), 1, "a template added on main makes the map due");
    assert.match(discoveries().at(-1).reason, new RegExp(`^templates/page\\.faq\\.json was added on main between \\w{7} and ${added.slice(0, 7)}$`));
    await success();
    const mapWritten = written();
    assert.equal(await poll(at(mapWritten, 1)), 0, "a map of the current main is kept");
    rmSync(site);
    assert.equal(await poll(at(mapWritten, 1)), 1, "a stored map that is gone is rediscovered");
    f.reset(0, "incomplete");
    const incomplete = await run();
    assert.equal(incomplete.error.code, "AGENT_INCOMPLETE"); assert.equal(f.row(s.tasks, incomplete.taskId).status, "failed");
    assert.equal(existsSync(site), false, "an incomplete discovery stores nothing"); assert.equal(written(), mapWritten);
    const retryAt = at(incomplete.finishedAt, live.storefront.siteMapRetryHours / 24);
    assert.equal(await poll(retryAt - 1 / 1440), 0, "an incomplete discovery is not queued again before siteMapRetryHours");
    assert.equal(await poll(retryAt + 1 / 1440), 1, "an incomplete discovery is queued again after siteMapRetryHours");
    assert.equal(discoveries().length, 6); assert.equal(discoveries().at(-1).subjectId, f.row(s.tasks, incomplete.taskId).subjectId);
    assert.match(discoveries().at(-1).reason, /is due; the last discovery was incomplete, retrying after \d+ h$/);

    f.reset(0, "normal"); live.storefront.enabled = false;
    const before = sessions().length, refused = await run();
    assert.match(refused.error.message, /storefront_discover runs only while storefront\.enabled is true/);
    assert.equal(sessions().length, before, "a discovery refused while the storefront is off reaches no agent"); assert.equal(existsSync(site), false);
    pushFile(pr.head.ref, "snippets/badge.liquid", "<span>off</span>\n");
    const off = await reviewed();
    assert.ok(off.length && off.every((request) => request.context.item.number === 201 && request.context.files.storefront === undefined && JSON.stringify(names(request)) === panel), "a disabled storefront gives no browser");
    assert.equal(all(s.sourceCursors).filter((row) => row.action === "storefront_discover").length, 1);
  } },
  storefront_review: { title: "a review of a Scrat PR whose preview matches the head gives every panel session the storefront section, the storefront browser and the preview, live and limits context; a confirmed regression caps the grade through the format correction and stays sticky, a missing line is corrected, unavailable keeps the grade, the line never reaches the comment, the consolidator sees each reviewer's result and its own line wins, and an unavailable preview, a human PR or a disabled storefront get neither section nor browser", seed: seedTheme, configure: [configureStorefront, (config) => { config.workflows.resolve_conflicts.enabled = false; }], run: async () => {
    const { config: live } = await f.app("config.ts"), { parseResult, storefrontProblem } = await f.app("results.ts");
    const parsed = (footer) => parseResult(`R.\n${footer}\nSCRAT_STATUS: complete`, [], { requireGrade: true });
    assert.throws(() => parsed("SCRAT_STOREFRONT: maybe\nSCRAT_GRADE: B"), /valid SCRAT_STOREFRONT: verified, regression, or unavailable/);
    assert.equal(parsed("```\nSCRAT_STOREFRONT: verified\n```\nSCRAT_GRADE: B").storefront, undefined, "a quoted line is report text");
    assert.match(storefrontProblem(parsed("SCRAT_GRADE: B"), "C", false), /must include SCRAT_STOREFRONT/);
    assert.match(storefrontProblem(parsed("SCRAT_STOREFRONT: regression\nSCRAT_GRADE: B"), "C", false), /regression caps the grade at C/);
    assert.deepEqual(["C", "D", "F"].map((grade) => storefrontProblem(parsed(`SCRAT_STOREFRONT: regression\nSCRAT_GRADE: ${grade}`), "C", false)), [undefined, undefined, undefined]);
    assert.match(storefrontProblem(parsed("SCRAT_STOREFRONT: verified\nSCRAT_GRADE: C"), "C", true), /An earlier answer reported SCRAT_STOREFRONT: regression/);
    assert.equal(storefrontProblem(parsed("SCRAT_STOREFRONT: unavailable\nSCRAT_GRADE: A"), "C", false), undefined);
    assert.deepEqual(parsed("SCRAT_STOREFRONT: unavailable\nSCRAT_GRADE: A"), { text: "R.", ready: false, paths: [], outcome: "complete", grade: "A", verdict: undefined, storefront: "unavailable", issues: undefined });
    f.loggie.processingPolls = 0;
    await implement(1);
    const pr = f.prs[0], names = (request) => request.request.tools.map((tool) => tool.function.name).filter((name) => name !== "codemode");
    let pushes = 0;
    const reviewOf = async (mode) => { if (pushes++) pushFile(pr.head.ref, "snippets/badge.liquid", `<span>${pushes}</span>\n`); f.reset(201, mode); const from = f.requests.length; await route(); const run = await success(); return { run, requests: f.requests.slice(from).filter((request) => request.context.action === "review_pr") }; };
    const comment = () => f.botComments(201).find((entry) => entry.body.includes("<!-- scrat-review -->")).body;
    const label = () => pr.labels.map((entry) => entry.name).filter((name) => / · /.test(name));
    const corrections = (requests) => requests.filter((request) => JSON.stringify(request.request.messages.at(-1)).includes("Your previous final answer was not accepted"));
    const outcome = ({ run }) => ({ grade: run.result.grade, storefront: run.result.storefront, line: comment().includes("SCRAT_STOREFRONT"), label: label() });
    const section = "\n## Storefront preview\n", panel = JSON.stringify(["read", "grep", "find", "ls", "git", "read_base"]);

    const verified = await reviewOf("storefront-verified");
    assert.equal(new Set(verified.requests.map((request) => `${request.request.model}/${request.consolidating}`)).size, 3, "both reviewers and the consolidator ran");
    for (const request of verified.requests) {
      assert.deepEqual(names(request), [...JSON.parse(panel), "browser"]);
      assert.match(request.request.tools.find((tool) => tool.function.name === "browser").function.description, /public https sites.*action=reset.*At most 80 actions and 1200 seconds per session/s);
      assert.ok(request.text.includes(section) && !request.text.includes("{{#storefront}}") && !request.text.includes("{{/storefront}}"));
    }
    const context = JSON.parse(readFileSync(verified.requests[0].context.files.storefront, "utf8")), preview = all(s.themePreviews).find((row) => !row.deletedAt);
    assert.deepEqual(context, { url: `https://shop.example.test/?preview_theme_id=${preview.themeId}`, themeId: preview.themeId, headSha: pr.head.sha, available: true, problems: [], liveUrl: "https://shop.example.test/", devices: ["desktop", "mobile"], confirmationRuns: 1, regressionMaxGrade: "C" });
    assert.ok(verified.requests[0].context.files.issue, "the reviewer has the linked issue");
    assert.deepEqual(outcome(verified), { grade: "A", storefront: "verified", line: false, label: ["A · Strong"] }); assert.equal(corrections(verified.requests).length, 0);

    const regression = await reviewOf("storefront-regression");
    assert.deepEqual(outcome(regression), { grade: "C", storefront: "regression", line: false, label: ["C · Needs work"] });
    const [correction] = corrections(regression.requests);
    assert.equal(corrections(regression.requests).length, 1); assert.equal(correction.consolidating, true);
    assert.match(JSON.stringify(correction.request.messages.at(-1)), /SCRAT_STOREFRONT: regression caps the grade at C.*SCRAT_STOREFRONT: verified, regression, or unavailable \(required for a complete review\)\\nSCRAT_GRADE/);
    assert.deepEqual(regression.run.reviewers.map((reviewer) => [reviewer.result.storefront, reviewer.result.grade]), [["regression", "A"], ["regression", "A"]], "reviewers are not capped; the consolidated grade is");

    const flip = await reviewOf("storefront-flip");
    assert.deepEqual(outcome(flip), { grade: "C", storefront: "regression", line: false, label: ["C · Needs work"] });
    assert.deepEqual(corrections(flip.requests).map((request) => /An earlier answer reported SCRAT_STOREFRONT: regression/.test(JSON.stringify(request.request.messages.at(-1)))), [false, true], "dropping regression after the cap is refused");

    const missing = await reviewOf("storefront-missing-once");
    assert.deepEqual(outcome(missing), { grade: "A", storefront: "verified", line: false, label: ["A · Strong"] });
    assert.deepEqual(corrections(missing.requests).map((request) => [request.consolidating, /must include SCRAT_STOREFRONT/.test(JSON.stringify(request.request.messages.at(-1)))]), [[true, true]]);

    const unavailable = await reviewOf("storefront-unavailable");
    assert.deepEqual(outcome(unavailable), { grade: "A", storefront: "unavailable", line: false, label: ["A · Strong"] }); assert.equal(corrections(unavailable.requests).length, 0);

    const split = await reviewOf("storefront-split");
    assert.deepEqual(split.run.reviewers.map((reviewer) => reviewer.result.storefront), ["regression", "verified"]);
    assert.deepEqual(outcome(split), { grade: "C", storefront: "regression", line: false, label: ["C · Needs work"] }, "the consolidator's line decides");
    const consolidation = split.requests.find((request) => request.consolidating);
    assert.match(consolidation.text, /re-run in the browser, after reset, only the storefront regressions and fix claims the reviewers report or disagree on/);
    assert.match(consolidation.text, /"grade": "A",\s*"storefront": "regression"[\s\S]*"grade": "A",\s*"storefront": "verified"/);

    const settled = f.botComments(201).length;
    mkdirSync(resolve("seed", "snippets"), { recursive: true }); changeMain("snippets/badge.liquid", "<span>main</span>\n"); f.reset(201, "normal"); const baseFrom = f.requests.length; await route();
    const baseOnly = await success(); assert.equal(baseOnly.reviewers.length, 1);
    const baseRequests = f.requests.slice(baseFrom).filter((request) => request.context.action === "review_pr");
    assert.ok(baseRequests.length && baseRequests.every((request) => request.context.files.storefront === undefined && !request.text.includes(section) && JSON.stringify(names(request)) === panel), "a base-only re-review does not browse");
    assert.equal(f.botComments(201).length, settled);

    f.loggie.wrongMd5.add("snippets/badge.liquid");
    const mismatched = await reviewOf("normal");
    assert.ok(mismatched.requests.length && mismatched.requests.every((request) => JSON.parse(readFileSync(request.context.files.storefront, "utf8")).available === false && !request.text.includes(section) && JSON.stringify(names(request)) === panel), "an unavailable preview lists storefront.json but gets no section and no browser");
    assert.equal(mismatched.run.result.storefront, undefined); assert.equal(mismatched.run.result.grade, "B");
    f.loggie.wrongMd5.clear();

    branchOff("human-7", "assets/app.css", "body { color: blue; }\n"); f.addPr(7, "human-7", "human");
    f.reset(7, "normal"); const from = f.requests.length; await route(); await success();
    const human = f.requests.slice(from).filter((request) => request.context.action === "review_pr");
    assert.ok(human.length && human.every((request) => request.context.item.number === 7 && request.context.files.storefront === undefined && !request.text.includes(section) && JSON.stringify(names(request)) === panel), "a human PR gets neither");

    live.storefront.enabled = false;
    const disabled = await reviewOf("normal");
    const skill = readFileSync(resolve("app/workflows/review_pr/SKILL.md"), "utf8").replace(/^\{\{#storefront\}\}\n[\s\S]*?^\{\{\/storefront\}\}\n/m, "").replaceAll("{{bot}}", "Scrat");
    assert.ok(disabled.requests.length && disabled.requests.every((request) => request.context.item.number === 201 && request.context.files.storefront === undefined && request.text.startsWith(skill) && JSON.stringify(names(request)) === panel), "a disabled storefront gets the unchanged skill and tools");
  } },
  cloudflare_issues: { title: "an enabled Cloudflare source files each active exception issue once it reaches the threshold and while fewer than maxOpen are open, files a new issue when a version unseen before a completed close recurs after it, but not for the old version or a not-planned close, never refiles across rounds, and gives the review a context file without headers or user data", configure: [(config) => { Object.assign(config.cloudflare, { enabled: true, services: ["api"] }); config.cloudflare.issues.maxOpen = 2; }], run: async () => {
    const { pollSources } = await f.app("poll-sources.ts"), { cloudflare } = f, base = Date.UTC(2026, 9, 30, 12);
    const leaked = "ghp_" + "a1B2c3D4e".repeat(4);
    const entry = (id, title, type, count, lastObserved) => ({ id, service: "api", title, type, status: "active", count, firstObserved: base, lastObserved, created: base, updated: lastObserved, activity: [] });
    cloudflare.issues.push(entry("cf-a", "Below threshold", "exception", 4, base + 1000), entry("cf-b", "TypeError in orders", "exception", 5, base + 2000), entry("cf-c", "Noisy log", "log", 9, base + 3000),
      entry("cf-d", "RangeError in cart", "exception", 7, base + 4000), entry("cf-e", "Over the cap", "exception", 6, base + 5000));
    const occurrence = (id, trace, extra = {}) => ({
      id, timestamp: base + 2500, error: { name: "TypeError", message: `Cannot read properties of undefined; token ${leaked}`, mechanism: "exception", handled: false, stack: "TypeError: Cannot read properties of undefined\n    at handler (assets/worker-entry-abc.js:10:5)\n    at async main (assets/worker-entry-abc.js:20:1)" },
      worker: { scriptName: "api", entrypoint: "default", executionModel: "stateless", scriptVersion: { id: "ver-1", tag: "v1" } },
      invocation: { id: "inv-" + id, type: "fetch", traceId: trace, method: "GET", path: "/orders", url: "https://api.example.test/orders?email=jo@example.test&session=SESSIONQ", statusCode: 500 },
      trail: [{ type: "log", level: "error", message: "order lookup failed", timestamp: base + 2400 }],
      request: { headers: { authorization: "Bearer hunter2hunter2" } }, context: { user: { id: "user-77" } }, ...extra,
    });
    for (const [id, trace] of [["cf-b", "trace-b"], ["cf-d", "trace-d"], ["cf-e", "trace-e"]]) cloudflare.occurrences.set(id, [occurrence("occ-" + id, trace)]);
    cloudflare.events.set("trace-b", [{ timestamp: base + 2450, level: "info", message: "fetching order 42" }]);
    const filed = () => f.written("issue"), closeIssue = (number, reason, at) => Object.assign(f.issues.get(number), { state: "closed", state_reason: reason, closed_at: new Date(at).toISOString() });
    const drain = async () => { while (all(s.tasks).some((task) => task.status === "queued")) await success(); };

    await pollSources();
    assert.deepEqual(filed().map((write) => write.title), ["api: TypeError in orders", "api: RangeError in cart"], "below the threshold, a log issue and the issue beyond maxOpen are not filed");
    const [first, second] = filed().map((write) => f.issues.get(write.number));
    assert.deepEqual(first.labels, [{ name: "cloudflare" }]);
    assert.ok(first.body.trimEnd().endsWith("<!-- scrat-fingerprint:cloudflare:cf-b -->") && first.body.includes("```text\nerror.name: TypeError") && first.body.includes("at handler (assets/worker-entry-abc.js:10:5)") && first.body.includes("- Occurrences: 5"));
    assert.ok(!first.body.includes(leaked) && first.body.includes("[redacted]") && !first.body.includes("hunter2hunter2") && !first.body.includes("user-77"));
    const listing = cloudflare.requests.find((request) => request.path.startsWith("/api/proxy/cf-fixture/accounts/acct123/workers/observability/issues?"));
    assert.equal(new URL("http://x" + listing.path).searchParams.get("perPage"), "50"); assert.equal(listing.key, f.loggie.key);

    await route(); await drain();
    const reviewed = f.requests.filter((request) => request.context.action === "review_issue" && request.context.item.number === first.number);
    assert.ok(reviewed.length && reviewed.every((request) => request.context.files.cloudflare !== undefined));
    const context = readFileSync(reviewed[0].context.files.cloudflare, "utf8");
    assert.ok(context.includes("untrusted") && context.includes("at async main (assets/worker-entry-abc.js:20:1)") && context.includes("order lookup failed") && context.includes("fetching order 42") && context.includes('"id": "ver-1"'));
    assert.ok(context.includes("https://api.example.test/orders\"") && !context.includes("jo@example.test") && !context.includes("SESSIONQ") && !context.includes("hunter2hunter2") && !context.includes("user-77") && !context.includes(leaked) && context.includes("[redacted]"));
    const query = cloudflare.requests.find((request) => request.path.endsWith("telemetry/query")).body;
    assert.equal(query.dry, true); assert.equal(query.view, "events"); assert.equal(query.limit, 50); assert.equal(query.parameters.filters[0].value, "trace-b");

    await pollSources(); await pollSources();
    assert.equal(filed().length, 2, "later rounds file nothing again");
    const row = (id) => JSON.parse(db.select().from(s.sourceCursors).all().find((cursor) => cursor.branch === id).sha);
    assert.deepEqual(row("cf-b"), { number: first.number, count: 5, lastObserved: base + 2000, updated: base + 2000 });

    cloudflare.issues = cloudflare.issues.filter((issue) => issue.id !== "cf-e");
    const closedAt = base + 10_000, version = (id) => ({ scriptName: "api", scriptVersion: { id } }), newest = (id, occurrences) => cloudflare.occurrences.set(id, [...occurrences, ...cloudflare.occurrences.get(id)]);
    const seen = (id, count, at) => Object.assign(cloudflare.issues.find((issue) => issue.id === id), { count, lastObserved: at, updated: at });
    closeIssue(first.number, "completed", closedAt); closeIssue(second.number, "not_planned", closedAt);
    newest("cf-b", [occurrence("occ-b2", "trace-b2", { timestamp: closedAt + 5000, worker: version("ver-1") })]); seen("cf-b", 9, closedAt + 5000);
    newest("cf-d", [occurrence("occ-d2", "trace-d2", { timestamp: closedAt + 6000, worker: version("ver-2") })]); seen("cf-d", 11, closedAt + 6000);
    await pollSources(); await pollSources();
    assert.equal(filed().length, 2, "an occurrence of the pre-close version and a not-planned close file nothing");
    cloudflare.occurrences.set("cf-b", cloudflare.occurrences.get("cf-b").filter((entry) => entry.timestamp > closedAt));
    newest("cf-b", [occurrence("occ-b4", "trace-b4", { timestamp: closedAt + 7000, worker: version("ver-1") })]); seen("cf-b", 10, closedAt + 7000);
    await pollSources();
    assert.equal(filed().length, 2, "the pre-close versions stay known after Cloudflare stops retaining their occurrences");
    newest("cf-b", [occurrence("occ-b3", "trace-b3", { timestamp: closedAt + 8000, worker: version("ver-2") })]); seen("cf-b", 11, closedAt + 8000);
    await pollSources();
    assert.equal(filed().length, 3, "an occurrence of a version never seen before the close files the recurrence");
    const recurrence = f.issues.get(filed()[2].number);
    assert.equal(recurrence.title, "api: TypeError in orders"); assert.deepEqual(recurrence.labels, [{ name: "cloudflare" }]);
    assert.ok(recurrence.body.startsWith(`Recurred after #${first.number} was closed on 2026-10-30; first seen again in Worker version \`ver-2\`.\n\n`) && recurrence.body.trimEnd().endsWith("<!-- scrat-fingerprint:cloudflare:cf-b -->"));
    assert.equal(f.issues.get(first.number).state, "closed"); assert.equal(f.issues.get(second.number).state, "closed");
    assert.equal(row("cf-b").number, recurrence.number);
    await pollSources(); await pollSources();
    assert.equal(filed().length, 3, "the recurrence is filed once");
    const { pollCloudflareIssues } = await f.app("cloudflare.ts"), lostTitle = "api: Lost response [redacted]";
    cloudflare.issues.push(entry("cf-f", "Lost response " + leaked, "exception", 5, closedAt + 9000)); cloudflare.occurrences.set("cf-f", [occurrence("occ-f", "trace-f", { timestamp: closedAt + 9000 })]);
    f.faults.issue.add(lostTitle);
    await pollCloudflareIssues();
    assert.equal(filed().length, 4); assert.ok(!all(s.sourceCursors).some((cursor) => cursor.branch === "cf-f"), "the lost response left no mapping");
    await pollCloudflareIssues(); await pollCloudflareIssues();
    assert.equal(filed().length, 4, "the issue created behind a lost response is adopted, not filed again");
    assert.equal(f.issues.get(row("cf-f").number).title, lostTitle, "the title is redacted");
  } },
  database: { title: "real PostgreSQL runs isolate databases, apply new migrations and remove resources", needsDocker: true, configure: [configureDatabase], run: async () => {
    const original = process.env.DATABASE_URL; f.addIssue(1); f.addIssue(2); f.enqueue(1, "implement"); f.enqueue(2, "implement");
    const runs = await Promise.all([f.runNextTask(), f.runNextTask()]);
    for (const r of runs) assert.equal(r.error, null, JSON.stringify(r.error));
    const urls = new Set(f.requests.map((r) => r.context.database.url)); assert.equal(urls.size, 2);
    assert.equal(new Set([...urls].map((url) => new URL(url).password)).size, 2);
    assert.equal(process.env.DATABASE_URL, original);
    for (const r of runs) assert.equal(execFileSync("docker", ["ps", "-a", "--filter", `name=^/scrat-v2-db-${r.id}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim(), "");
    const { createRunDatabase, removeRunDatabase } = await f.app("databases.ts");
    try {
      const databases = await Promise.all(runs.map((run) => createRunDatabase(run.id, "postgres:16-alpine")));
      const address = execFileSync("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", databases[0].container], { encoding: "utf8" }).trim();
      assert.ok(address);
      const query = (password) => execFileSync("docker", ["exec", "--env", `PGPASSWORD=${password}`, databases[1].container,
        "psql", "-h", address, "-U", "postgres", "-d", "scrat_test", "-Atc", "SELECT 1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(query(new URL(databases[0].url).password).trim(), "1");
      assert.throws(() => query(new URL(databases[1].url).password), /password authentication failed/);
      assert.throws(() => query("postgres"), /password authentication failed/);
    } finally { await Promise.all(runs.map((run) => removeRunDatabase(run.id))); }
  } },
  generated_diff_guard: { title: "review git summarizes large lockfile and generated diffs deterministically while keeping raw opt-in, small diffs and review scope intact", run: async () => {
    const { createReviewGitTool } = await f.app("review-git.ts");
    const repo = resolve("gen-repo");
    mkdirSync(resolve(repo, "src"), { recursive: true }); mkdirSync(resolve(repo, "assets"), { recursive: true });
    git(repo, "init", "-b", "main");
    writeFileSync(resolve(repo, "src/app.ts"), "export const version = 1;\n");
    writeFileSync(resolve(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  'alpha@1.0.0':\n    resolution: {integrity: sha512-old}\n");
    writeFileSync(resolve(repo, "assets/main-Ab12Cd.css"), ".a{color:red}\n");
    writeFileSync(resolve(repo, "assets/index-Tiny1.css"), ".t{color:blue}\n");
    git(repo, "add", "."); commit(repo, "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(resolve(repo, "src/app.ts"), "export const version = 2;\n");
    writeFileSync(resolve(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n" + Array.from({ length: 120 }, (_, i) => `  'pkg-${i}@2.0.${i}':\n    resolution: {integrity: sha512-${"x".repeat(40)}}\n`).join(""));
    writeFileSync(resolve(repo, "assets/main-Ab12Cd.css"), `.b{content:"${"z".repeat(6000)}"}\n`);
    writeFileSync(resolve(repo, "assets/index-Tiny1.css"), ".t{color:green}\n");
    git(repo, "add", "."); commit(repo, "head");
    const head = git(repo, "rev-parse", "HEAD");

    const touched = new Set();
    const tool = createReviewGitTool(repo, { base, head, main: base }, touched);
    const call = async (args) => (await tool.execute("call", args, undefined, undefined, {})).content[0].text;

    const lockSummary = await call({ operation: "diff", from: "base", to: "head", path: "pnpm-lock.yaml" });
    assert.match(lockSummary, /pnpm-lock\.yaml/);
    assert.match(lockSummary, /Added\/updated entries.*pkg-0@2\.0\.0/);
    assert.match(lockSummary, /generated\/lockfile diff omitted.*include_generated=true/);
    assert.ok(lockSummary.length < 3000, "lockfile summary stays compact");
    assert.ok(touched.has("pnpm-lock.yaml"), "summarized path still joins touched scope");

    const lockRaw = await call({ operation: "diff", from: "base", to: "head", path: "pnpm-lock.yaml", include_generated: true });
    assert.match(lockRaw, /diff --git a\/pnpm-lock\.yaml b\/pnpm-lock\.yaml/);

    const smallGen = await call({ operation: "diff", from: "base", to: "head", path: "assets/index-Tiny1.css" });
    assert.match(smallGen, /\+\.t\{color:green\}/, "small generated diff passes through verbatim");

    // Small generated diff with tiny page limit must not be misclassified as > generatedDiffBytes
    const smallPaged = await call({ operation: "diff", from: "base", to: "head", path: "assets/index-Tiny1.css", limit: 60 });
    assert.match(smallPaged, /^diff --git a\/assets\/index-Tiny1\.css/);
    assert.doesNotMatch(smallPaged, /generated\/lockfile diff omitted/);

    // Generated diff summary honors caller limit and pages cleanly across offset > 0 without leaking raw generated lines
    const lockPage1 = await call({ operation: "diff", from: "base", to: "head", path: "pnpm-lock.yaml", limit: 80 });
    const lockNext = Number(/offset=(\d+)/.exec(lockPage1)?.[1]);
    assert.ok(lockNext > 0 && lockNext <= 80, lockPage1);
    assert.match(lockPage1, /\[truncated: bytes 0-/);
    const lockPage2 = await call({ operation: "diff", from: "base", to: "head", path: "pnpm-lock.yaml", offset: lockNext, limit: 4000 });
    assert.match(lockPage2, /generated\/lockfile diff omitted/);
    assert.doesNotMatch(lockPage2, /sha512-xxxxx/);

    const broad = await call({ operation: "diff", from: "base", to: "head" });
    assert.match(broad, /\+export const version = 2;/, "broad diff keeps regular source patch");
    assert.doesNotMatch(broad, /sha512-xxxxx/, "broad diff omits raw lockfile bloat");
    assert.match(broad, /omitted 3 generated\/lockfile diff\(s\):.*assets\/main-Ab12Cd\.css.*pnpm-lock\.yaml/);

    // Mixed broad diff pagination stays on the filtered regular-files stream across offset > 0 and keeps notice inside page budget
    const p1 = await call({ operation: "diff", from: "base", to: "head", limit: 80 });
    const nextOff = Number(/offset=(\d+)/.exec(p1)?.[1]);
    assert.ok(nextOff > 0 && nextOff <= 80, p1);
    const p2 = await call({ operation: "diff", from: "base", to: "head", offset: nextOff, limit: 800 });
    assert.match(p2, /\+export const version = 2;/, "page 2 continues the filtered regular-files diff");
    assert.doesNotMatch(p2, /sha512-xxxxx|zzzzzz/, "page 2 never leaks omitted generated diffs");
    const p3 = await call({ operation: "diff", from: "base", to: "head", offset: 250, limit: 400 });
    assert.doesNotMatch(p3, /\[omitted \d+ generated/, "omission notice is not repeated on later pages");

    // Large mixed diff (> 200 regular files + generated lockfile) still excludes generated diffs
    mkdirSync(resolve(repo, "src/many"), { recursive: true });
    for (let i = 0; i < 210; i++) writeFileSync(resolve(repo, `src/many/f${i}.ts`), `export const n${i} = ${i};\n`);
    writeFileSync(resolve(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n" + Array.from({ length: 130 }, (_, i) => `  'big-${i}@3.0.${i}':\n    resolution: {integrity: sha512-${"y".repeat(40)}}\n`).join(""));
    git(repo, "add", "."); commit(repo, "many-files");
    const manyHead = git(repo, "rev-parse", "HEAD");
    const manyTool = createReviewGitTool(repo, { base: head, head: manyHead, main: base }, new Set());
    const manyDiff = (await manyTool.execute("call", { operation: "diff", from: "base", to: "head" }, undefined, undefined, {})).content[0].text;
    assert.match(manyDiff, /src\/many\/f0\.ts/, "large mixed diff keeps regular files");
    assert.doesNotMatch(manyDiff, /sha512-yyyyy/, "large mixed diff (>200 regular files) still filters out lockfile");
    assert.match(manyDiff, /omitted 1 generated\/lockfile diff\(s\):.*pnpm-lock\.yaml/);
  } },
  d1_filtering: { title: "d1 perceptual filtering distills large bash, browser text and history outputs into verbatim spans with contextDir escape hatches and fail-open fallback", configure: [(config) => {
    config.d1.enabled = true;
    config.d1.url = "https://codex.unblocklabs.ai/v1/decisions";
    config.d1.bash.minChars = 400;
    config.d1.bash.maxOutputChars = 2200;
    config.d1.browserText.minChars = 300;
    config.d1.browserText.maxOutputChars = 1400;
    config.d1.history.minChars = 300;
    config.d1.history.maxOutputChars = 1400;
    config.d1.failureBlocks.skipD1OnMatch = false;
  }], run: async () => {
    const prevToken = process.env.CODEX_LB_API_KEY, prevFetch = globalThis.fetch;
    process.env.CODEX_LB_API_KEY = "d1-secret-token-value-99999";
    let failD1 = false, fail429Count = 0, d1Calls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "https://codex.unblocklabs.ai/v1/decisions") return prevFetch(url, init);
      d1Calls++;
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer d1-secret-token-value-99999");
      if (fail429Count > 0) {
        fail429Count--;
        return new Response(JSON.stringify({ error: { message: "at capacity" } }), { status: 429, headers: { "retry-after": "0" } });
      }
      if (failD1) return new Response("overloaded", { status: 500 });
      const body = JSON.parse(init.body);
      assert.equal(body.model, "liquid/d1.2-ultra");
      assert.ok(!body.state.includes("d1-secret-token-value-99999"), "secrets in text, goal, focus, and history must be redacted before reaching d1");
      const answers = {};
      for (const key of Object.keys(body.questions)) {
        const idx = key.slice(1);
        const match = new RegExp(`\\[${idx}\\]([\\s\\S]*?)(?=\\n\\n\\[\\d+\\]|$)`).exec(body.state);
        const chunk = match?.[1] ?? "";
        const hot = /FAIL src\/orders\.test\.ts|AssertionError|Add to cart|OUT OF STOCK|recurring checkout|TAIL_SENTINEL_BUG/i.test(chunk);
        answers[key] = { type: "noul", noul: hot ? 0.92 : 0.05 };
      }
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const { distillCommandOutput, distillHistory, readHeadAndTail } = await f.app("d1.ts");
      const { createBrowserTool } = await f.app("scoped-tools.ts");
      const { createAgentTools } = await f.app("tools.ts");
      const { logger } = await f.app("logging.ts");
      const ctxDir = resolve("d1-ctx"); mkdirSync(ctxDir, { recursive: true });

      // readHeadAndTail preserves tail + UTF-8 boundaries and redacts secrets straddling cut boundaries
      const bigLogPath = resolve(ctxDir, "big-utf8.log");
      const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + "SECRETKEYLINE".repeat(20) + "\n-----END RSA PRIVATE KEY-----";
      writeFileSync(bigLogPath, `HEAD_START\n${"🚀".repeat(250)}d1-secret-token-value-99999${"x".repeat(20000)}${pem}${"y".repeat(20000)}d1-secret-token-value-99999\nREAL_TAIL_FAILURE: line 999\n`);
      const ht = await readHeadAndTail(bigLogPath, 2048);
      assert.equal(ht.truncated, true);
      assert.match(ht.text, /^HEAD_START/);
      assert.match(ht.text, /REAL_TAIL_FAILURE: line 999/);
      assert.ok(!ht.text.includes("\uFFFD"), "UTF-8 boundaries preserved across head/tail cut");
      assert.ok(!ht.text.includes("d1-secret-token-value-99999") && !ht.text.includes("SECRETKEYLINE"), "boundary-crossing secrets redacted before clipping");

      // bash wrapper preserves promptSnippet, avoids parallel filename races, and keeps exit-0 literal stdout
      const wsDir = resolve("d1-ws"); mkdirSync(wsDir, { recursive: true });
      const { customTools: changeTools } = await createAgentTools({ run: { id: "bash-meta" }, cwd: wsDir, contextDir: ctxDir, tools: ["read", "bash"], scoped: { mode: "change" }, log: logger });
      const bashTool = changeTools.find((t) => t.name === "bash");
      assert.ok(bashTool.promptSnippet, "bash retains promptSnippet for Pi system prompt <tools>");
      const bashCtx = { sessionManager: { getSessionId: () => "bash-test-sess", getSessionFile: () => undefined } };
      const [parA, parB] = await Promise.all([
        bashTool.execute("p1", { command: `node -e 'console.log("RUN_ALPHA\\n" + "ok line\\n".repeat(400) + "FAIL src/orders.test.ts ALPHA_ONLY\\n" + "ok line\\n".repeat(400))'` }, undefined, undefined, bashCtx),
        bashTool.execute("p2", { command: `node -e 'console.log("RUN_BETA\\n" + "ok line\\n".repeat(400) + "FAIL src/orders.test.ts BETA_ONLY\\n" + "ok line\\n".repeat(400))'` }, undefined, undefined, bashCtx),
      ]);
      assert.ok(parA.details.fullOutputPath && parB.details.fullOutputPath && parA.details.fullOutputPath !== parB.details.fullOutputPath, "parallel bash calls get distinct artifact paths");
      assert.match(readFileSync(parA.details.fullOutputPath, "utf8"), /ALPHA_ONLY/);
      assert.match(readFileSync(parB.details.fullOutputPath, "utf8"), /BETA_ONLY/);
      const exit0Literal = await bashTool.execute("p3", { command: `node -e 'process.stdout.write("START\\n" + "x".repeat(600) + "\\n\\nCommand exited with code 0")'` }, undefined, undefined, bashCtx);
      assert.match(exit0Literal.content[0].text, /Command exited with code 0$/, "exit-0 stdout ending with exit line is preserved");

      const noisyLog = [
        "\x1b[32mRUN  v2.0.0\x1b[0m",
        ...Array.from({ length: 40 }, (_, i) => ` ✓ test/passing-${i}.test.ts (12ms) ok ${".".repeat(80)}`),
        "\n\x1b[31mFAIL src/orders.test.ts > charges tax once\x1b[0m\nAssertionError: expected 108 to equal 100 (token d1-secret-token-value-99999)\n    at src/orders.ts:42:9\n",
        ...Array.from({ length: 40 }, (_, i) => ` ✓ test/more-passing-${i}.test.ts (8ms) ok ${".".repeat(80)}`),
        "Test Files  1 failed | 80 passed (81)",
      ].join("\n");

      const bashLog = resolve(ctxDir, "bash-1.log");
      fail429Count = 1;
      const longSecretCmd = `pnpm exec vitest run ${"--filter=pkg ".repeat(10)}--token=d1-secret-token-value-99999`;
      const cmdRes = await distillCommandOutput({ rawOutput: noisyLog, command: longSecretCmd, artifactPath: bashLog, minChars: 400, maxChars: 2200 });
      assert.equal(fail429Count, 0, "transient HTTP 429 was retried and recovered");
      assert.equal(cmdRes.filtered, true);
      assert.match(cmdRes.text, /\[d1 filtered:/);
      assert.match(cmdRes.text, /FAIL src\/orders\.test\.ts/);
      assert.match(cmdRes.text, /src\/orders\.ts:42:9/);
      assert.ok(cmdRes.text.length <= 2200, `d1 formatted summary enforces maxChars: got ${cmdRes.text.length}`);
      assert.doesNotMatch(cmdRes.text, /\x1b\[/, "ANSI escape codes are stripped");
      assert.doesNotMatch(cmdRes.text, /d1-secret-token-value-99999/, "d1 token is redacted");
      assert.ok(cmdRes.text.includes(bashLog) && readFileSync(bashLog, "utf8").includes("FAIL src/orders.test.ts"), "full log saved for read escape hatch");
      assert.ok(cmdRes.text.length < noisyLog.length / 2, "significant token compression achieved");

      // sourceArtifactPath preserves full redacted middle content and never leaks secrets across 256 KiB chunk boundaries
      const rawBigSrc = resolve(ctxDir, "raw-big-src.log");
      const ghpTok = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].join("_");
      const xoxTok = ["xoxb", "1234567890", "1234567890", "abcdefghijklmnopqrstuvwx"].join("-");
      // Place PEM across the (256 KiB - 8 KiB) split boundary and ghp_ across the exact 256 KiB read boundary
      const prefixBeforeGhp = `HEAD_LINE\n${"a".repeat(256 * 1024 - 8192 - 40)}\n${pem}\n`;
      const pad2Len = Math.max(0, 256 * 1024 - Buffer.byteLength(prefixBeforeGhp, "utf8") - 10);
      writeFileSync(rawBigSrc, `${prefixBeforeGhp}${"b".repeat(pad2Len)} ${ghpTok}\nMIDDLE_ONLY_SENTINEL_12345 ${xoxTok} d1-secret-token-value-99999\n${"c".repeat(2000)}\nFAIL src/orders.test.ts\n`);
      const fullCopyDest = resolve(ctxDir, "full-copy.log");
      const fullCopyRes = await distillCommandOutput({ rawOutput: noisyLog, command: "pnpm test", artifactPath: fullCopyDest, sourceArtifactPath: rawBigSrc, partialSource: true, minChars: 400, maxChars: 2200 });
      assert.equal(fullCopyRes.artifactPath, fullCopyDest);
      assert.match(fullCopyRes.text, /full output:.*full-copy\.log/);
      const copiedText = readFileSync(fullCopyDest, "utf8");
      assert.match(copiedText, /MIDDLE_ONLY_SENTINEL_12345/, "full source artifact preserves middle diagnostics");
      assert.ok(!copiedText.includes("d1-secret-token-value-99999") && !copiedText.includes("SECRETKEYLINE") && !copiedText.includes("ghp_1234") && !copiedText.includes("uvwxyzABCD") && !copiedText.includes("xoxb-1234"), "chunk-boundary secrets fully redacted");

      const readCmd = await distillCommandOutput({ rawOutput: noisyLog, command: "cat src/orders.ts", artifactPath: resolve(ctxDir, "skip.log"), minChars: 400, maxChars: 2200 });
      assert.equal(readCmd.filtered, false, "code-read shell commands bypass d1 filtering");
      const forcedVal = await distillCommandOutput({ rawOutput: noisyLog, command: "git diff --exit-code", allowReadBypass: false, artifactPath: resolve(ctxDir, "val-diff.log"), minChars: 400, maxChars: 2200 });
      assert.equal(forcedVal.filtered, true, "validation disables read-command bypass");

      failD1 = true;
      const warnHeavy = Array.from({ length: 120 }, (_, i) => `warning ${i}: ${"detail ".repeat(25)}`).join("\n") + "\nFAIL src/orders.test.ts\n";
      const fallback = await distillCommandOutput({ rawOutput: warnHeavy, command: "pnpm exec vitest run", artifactPath: resolve(ctxDir, "fallback.log"), minChars: 400, maxChars: 2200 });
      assert.equal(fallback.filtered, true);
      assert.match(fallback.text, /STRUCTURED FAILURES[\s\S]*FAIL src\/orders\.test\.ts/);
      assert.match(fallback.text, /truncated \d+ chars/);
      assert.ok(fallback.text.length <= 2200, `fallback respects maxChars with anomalies: got ${fallback.text.length}`);
      failD1 = false;

      // Test F5-01 Trigger 1 (-----END straddling limit), Trigger 2 (completed PEM before limit with non-newline tail), and R5-02 (unbroken line opaque secret straddling limit)
      const { copyRedactedFile } = await f.app("d1.ts");
      const pemEndLimit = 256 * 1024 - 8192;
      const pemEndPos = pem.indexOf("-----END ");
      const trig1Src = resolve(ctxDir, "pem-end-straddle.log");
      const trig1Dst = resolve(ctxDir, "pem-end-straddle.out.log");
      writeFileSync(trig1Src, "a".repeat(pemEndLimit - pemEndPos - 10) + pem + "\n" + "z".repeat(12000));
      await copyRedactedFile(trig1Src, trig1Dst, 1024 * 1024);
      assert.ok(!readFileSync(trig1Dst, "utf8").includes("SECRETKEYLINE"), "PEM with -----END straddling limit is redacted");

      const trig2Src = resolve(ctxDir, "pem-before-limit.log");
      const trig2Dst = resolve(ctxDir, "pem-before-limit.out.log");
      writeFileSync(trig2Src, "a".repeat(pemEndLimit - pem.length - 50) + pem + "json_tail".repeat(20) + "\n" + "z".repeat(12000));
      await copyRedactedFile(trig2Src, trig2Dst, 1024 * 1024);
      assert.ok(!readFileSync(trig2Dst, "utf8").includes("SECRETKEYLINE"), "PEM ending before limit with non-newline suffix is redacted");

      const unbrokenSrc = resolve(ctxDir, "unbroken-secret.log");
      const unbrokenDst = resolve(ctxDir, "unbroken-secret.out.log");
      writeFileSync(unbrokenSrc, "x".repeat(pemEndLimit - 12) + "d1-secret-token-value-99999" + "y".repeat(20000));
      await copyRedactedFile(unbrokenSrc, unbrokenDst, 1024 * 1024);
      assert.ok(!readFileSync(unbrokenDst, "utf8").includes("d1-secret-token-value-99999"), "opaque secret straddling cut inside unbroken 270KiB line is redacted");

      // Mid-size d1 inflation rejection must not leave an orphan artifact file
      const orphanPath = resolve(ctxDir, "should-not-exist.log");
      const midSize = Array.from({ length: 8 }, (_, i) => `line ${i}: ${"payload ".repeat(12)}`).join("\n");
      const midRes = await distillCommandOutput({ rawOutput: midSize, command: "pnpm test", artifactPath: orphanPath, minChars: 400, maxChars: 2200 });
      assert.equal(midRes.filtered, false);
      assert.equal(existsSync(orphanPath), false, "rejected mid-size d1 output writes no orphan artifact");

      // If persistArtifact fails and falls back to existingArtifactPath, label stays "full output" even with partialSource
      const badDirArtifact = resolve(ctxDir, "missing-dir/bash.log");
      const existingFull = resolve(ctxDir, "existing-full.log");
      const fbLabelRes = await distillCommandOutput({ rawOutput: noisyLog, command: "pnpm test", artifactPath: badDirArtifact, existingArtifactPath: existingFull, partialSource: true, minChars: 400, maxChars: 2200 });
      assert.equal(fbLabelRes.artifactPath, existingFull);
      assert.match(fbLabelRes.text, /full output:.*existing-full\.log/);
      assert.doesNotMatch(fbLabelRes.text, /partial head\+tail/);

      // 35 KB page with detail near the tail proves priority wave packing never drops pinned tail chunks
      let pageBody = [
        "Header Nav Shop About FAQ Reviews Login Cart\n" + "Menu item navigation boilerplate link ".repeat(60),
        "\n\n## Product Details\nDaily Focus Pack — $48.00\nAdd to cart button disabled: OUT OF STOCK on mobile variant.\n\n",
        ...Array.from({ length: 24 }, (_, i) => `## Section ${i}\n${"Filler marketing paragraph text ".repeat(45)}\n`),
        "\n\n## Footer Status\nTAIL_SENTINEL_BUG: checkout broken at bottom of 35KB page\n",
      ].join("\n");
      const stubPage = {
        goto: async () => ({ status: () => 200 }), title: async () => "Product", url: () => "https://shop.example.test/products/focus",
        innerText: async () => pageBody, screenshot: async () => {}, innerHTML: async () => "<html></html>",
        waitForLoadState: async () => {}, on: () => {}, off: () => {}, setViewportSize: async () => {},
        locator: () => ({ count: async () => 1 }), click: async () => {}, fill: async () => {}, selectOption: async () => {},
      };
      const { tool: browserTool, close } = createBrowserTool({
        settings: { navigationHosts: ["shop.example.test"], resourceHosts: [] }, contextDir: ctxDir, runId: "d1-run", sessionTag: "sess-a",
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        launch: async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => stubPage, close: async () => {} }), close: async () => {} }),
      });
      try {
        await browserTool.execute("c1", { action: "goto", url: "https://shop.example.test/products/focus" }, undefined, undefined, {});
        const filteredText = (await browserTool.execute("c2", { action: "text", focus: "check d1-secret-token-value-99999 and TAIL_SENTINEL_BUG" }, undefined, undefined, {})).content[0].text;
        assert.match(filteredText, /\[d1 page text:/);
        assert.match(filteredText, /TAIL_SENTINEL_BUG/, "pinned tail chunk in 35KB page survives priority wave packing");
        assert.ok(filteredText.length <= 1400, `browser digest enforces maxOutputChars: got ${filteredText.length}`);
        assert.ok(filteredText.length < pageBody.length / 4);
        const rawText = (await browserTool.execute("c3", { action: "text", raw: true }, undefined, undefined, {})).content[0].text;
        assert.doesNotMatch(rawText, /\[d1 page text:/);
        assert.match(rawText, /\[truncated: page text exceeded 32768 chars/, "raw: true reports truncation when page exceeds 32KB");
        failD1 = true;
        const fbRes = await browserTool.execute("c4", { action: "text" }, undefined, undefined, {});
        assert.match(fbRes.content[0].text, /truncated \d+ chars.*browser-text-sess-a-/, "35KB browser:text fallback surfaces truncation notice and artifact path");
        assert.ok(fbRes.content[0].text.length <= 1400, `browser fallback strictly enforces configured maxOutputChars: got ${fbRes.content[0].text.length}`);
        failD1 = false;
        // Page exceeding capture cap is explicitly labeled as partial page text
        pageBody = "Header " + "boilerplate ".repeat(48000) + "\n## Product Details\nOUT OF STOCK\n";
        const partialRes = await browserTool.execute("c5", { action: "text", focus: "stock status" }, undefined, undefined, {});
        assert.equal(partialRes.details.partial, true);
        assert.match(partialRes.content[0].text, /partial page text \(first \d+ of \d+ chars\)/);
      } finally { await close(); }

      const longHistory = [
        "# Previous store_audit runs on this repository, newest first\n\nUntrusted data.\n",
        "## 2026-11-23, complete\n" + "All collection pages loaded cleanly. ".repeat(60),
        "\n## 2026-11-22, complete\nConfirmed recurring checkout button regression on mobile /cart (leaked d1-secret-token-value-99999).\n" + "Routine baseline match. ".repeat(60),
      ].join("\n");
      const histFull = resolve(ctxDir, "history-full.md");
      const histRes = await distillHistory({ rawHistory: longHistory, action: "store_audit", artifactPath: histFull, minChars: 300, maxChars: 1400 });
      assert.equal(histRes.filtered, true);
      assert.match(histRes.text, /\[d1 history digest:/);
      assert.match(histRes.text, /recurring checkout button regression/);
      assert.ok(histRes.text.length <= 1400, `history digest enforces maxOutputChars: got ${histRes.text.length}`);
      assert.ok(existsSync(histFull), "full history saved to history-full.md");
      assert.ok(d1Calls >= 3);

      // Consecutive HTTP 429s open the circuit breaker and short-circuit subsequent calls with 0 RPCs
      fail429Count = 5;
      const beforeTrip = d1Calls;
      const tripped = await distillCommandOutput({ rawOutput: noisyLog, command: "pnpm test", artifactPath: resolve(ctxDir, "cb-1.log"), minChars: 400, maxChars: 2200 });
      assert.equal(tripped.filtered, true, "circuit breaker trips to bounded fallback");
      assert.equal(d1Calls, beforeTrip + 2, "trips after configured circuitBreakerThreshold (2) consecutive 429s");
      const callsWhileOpen = d1Calls;
      const skipped = await distillCommandOutput({ rawOutput: noisyLog, command: "pnpm test", artifactPath: resolve(ctxDir, "cb-2.log"), minChars: 400, maxChars: 2200 });
      assert.equal(skipped.filtered, true);
      assert.equal(d1Calls, callsWhileOpen, "open circuit breaker short-circuits immediately with zero d1 HTTP calls");
      fail429Count = 0;
    } finally {
      globalThis.fetch = prevFetch;
      if (prevToken === undefined) delete process.env.CODEX_LB_API_KEY; else process.env.CODEX_LB_API_KEY = prevToken;
    }
  } },
  deterministic_grep: { title: "deterministic rg --json grep keeps full scan recall past generated noise, deduplicates context, clips lines around matches, spills recoverable overflow outside review scope and rejects invalid regexes", configure: [(config) => {
    config.tools.grep.inlineBytes = 4096;
  }], run: async () => {
    const { createAgentTools } = await f.app("tools.ts");
    const { logger } = await f.app("logging.ts");
    const ws = resolve("grep-ws"), ctxDir = resolve("grep-ctx");
    mkdirSync(resolve(ws, "src"), { recursive: true });
    mkdirSync(resolve(ws, "assets"), { recursive: true });
    mkdirSync(ctxDir, { recursive: true });

    // File #1 alphabetically: generated CSS with 150 matches that would kill legacy rg at limit=100
    writeFileSync(resolve(ws, "assets/main-Ab12Cd.css"), Array.from({ length: 150 }, (_, i) => `.rule-${i}{content:"targetSymbol_${i}"}`).join("\n") + "\n");
    // Source files including adjacent matches for context dedup, long UTF-8 line, and sole late caller
    writeFileSync(resolve(ws, "src/adjacent.ts"), "const a = 1;\nconst hit1 = targetSymbol();\nconst mid = 2;\nconst hit2 = targetSymbol();\nconst b = 3;\n");
    writeFileSync(resolve(ws, "src/long.ts"), `${"🚀".repeat(120)} const deep = targetSymbol("exact-token"); ${"🔥".repeat(120)}\n`);
    for (let i = 0; i < 12; i++) {
      writeFileSync(resolve(ws, `src/mod_${String(i).padStart(2, "0")}.ts`), Array.from({ length: 6 }, (_, j) => `export const f${i}_${j} = () => targetSymbol(${i}, ${j});`).join("\n") + "\n");
    }
    writeFileSync(resolve(ws, "src/z_sole_caller.ts"), "export function lateConsumer() { return targetSymbol('sole'); }\n");

    const { customTools, paths } = await createAgentTools({
      run: { id: "grep-run" }, cwd: ws, contextDir: ctxDir, tools: ["read", "grep"],
      scoped: { mode: "review" }, log: logger,
    }, 0);
    const grepTool = customTools.find((t) => t.name === "grep");
    const readTool = customTools.find((t) => t.name === "read");
    const runGrep = (args) => grepTool.execute("c", args, undefined, undefined, {});

    // 1. Confinement preserved
    await assert.rejects(runGrep({ pattern: "targetSymbol", path: ".." }), /outside the workspace/);
    await assert.rejects(runGrep({ pattern: "targetSymbol", path: "~" }), /outside the workspace/);

    // 2. Clean zero vs invalid regex (must never become clean zero)
    const zero = (await runGrep({ pattern: "definitely_absent_symbol_xyz", literal: true })).content[0].text;
    assert.match(zero, /scan: complete \| display: full .* 0 matches/);
    await assert.rejects(runGrep({ pattern: "(unclosed" }), /regex|parse|error/i);

    // 3. Context dedup + clamping (context: 30 accepted by schema and clamped to 10; mode: "content" accepted as matches alias)
    const adj = (await runGrep({ pattern: "targetSymbol", path: "src/adjacent.ts", context: 30, mode: "content" })).content[0].text;
    assert.match(adj, /scan: complete \| display: full/);
    assert.equal(adj.split("const mid = 2;").length - 1, 1, "overlapping context line is emitted once");
    assert.equal(grepTool.parameters.properties.context.maximum, undefined, "context schema must not reject values > 10");

    // 4. Match-centered UTF-8 safe clipping on long line
    const longRes = (await runGrep({ pattern: "exact-token", path: "src/long.ts", literal: true })).content[0].text;
    assert.match(longRes, /exact-token/, "match stays visible inside centered window");
    assert.match(longRes, /\[clipped: \d+B\]/);
    assert.ok(!longRes.includes("\uFFFD"), "UTF-8 boundary clipping produces no replacement chars");

    // 5. Overflow shaping past 150 generated matches: complete scan, late caller visible, generated collapsed to count, spill readable (with context) without polluting paths
    const overflow = await runGrep({ pattern: "targetSymbol", literal: true, context: 1 });
    const text = overflow.content[0].text;
    assert.ok(Buffer.byteLength(text, "utf8") <= 4096, `inline budget enforced: got ${Buffer.byteLength(text, "utf8")}B`);
    assert.match(text, /scan: complete \| display: reduced/);
    assert.match(text, /assets\/main-Ab12Cd\.css: 150 \[generated\]/, "generated file accounted for in inventory");
    assert.match(text, /src\/z_sole_caller\.ts: 1/, "sole late caller discovered past 150 earlier matches");
    assert.match(text, /lateConsumer\(\)/, "round-robin previews prioritize real source files over generated bundle");
    assert.doesNotMatch(text, /\.rule-0\{/, "generated bundle collapsed to count instead of burning snippet space");
    assert.ok(overflow.details.spillPath && existsSync(overflow.details.spillPath), "spill file written in contextDir");

    // Read spill file via read tool -> readable, preserves requested context lines, & must NOT enter workspace review paths
    const spilled = (await readTool.execute("r1", { path: overflow.details.spillPath, limit: 30 }, undefined, undefined, {})).content[0].text;
    assert.match(spilled, /## FILE INDEX[\s\S]*assets\/main-Ab12Cd\.css: 150/);
    assert.match(readFileSync(overflow.details.spillPath, "utf8"), /src\/adjacent\.ts:3- const mid = 2;/, "spill file preserves requested context lines");
    assert.equal(paths.size, 0, "reading spill artifact outside worktree does not pollute review paths");

    // 6. mode: "files" returns compact inventory
    const filesMode = (await runGrep({ pattern: "targetSymbol", literal: true, mode: "files" })).content[0].text;
    assert.match(filesMode, /mode: files \| scan: complete \| display: full/);
    assert.match(filesMode, /src\/z_sole_caller\.ts: 1/);

    // 7. params.glob cannot override contextDir/grep spill-dir exclusion
    writeFileSync(resolve(ctxDir, "note.txt"), "context_needle_here\n");
    const ctxSearch = (await runGrep({ pattern: "targetSymbol", path: ctxDir, glob: "*.txt", literal: true })).content[0].text;
    assert.match(ctxSearch, /0 matches/, "spill files under contextDir/grep stay excluded even with glob=*.txt");

    // 8. Aborted AbortSignal rejects instead of returning a partial result
    const ac = new AbortController(); ac.abort();
    await assert.rejects(grepTool.execute("ab", { pattern: "targetSymbol", literal: true }, ac.signal, undefined, {}), /Operation aborted/);

    // 9. Symlinked cwd preserves repo-relative paths and generated-file detection
    const symlinkWs = resolve("grep-ws-link");
    symlinkSync(ws, symlinkWs);
    const { customTools: symTools } = await createAgentTools({ run: { id: "grep-sym" }, cwd: symlinkWs, contextDir: ctxDir, tools: ["read", "grep"], scoped: { mode: "review" }, log: logger }, 0);
    const symOut = (await symTools.find((t) => t.name === "grep").execute("s1", { pattern: "targetSymbol", literal: true }, undefined, undefined, {})).content[0].text;
    assert.match(symOut, /assets\/main-Ab12Cd\.css: 150 \[generated\]/, "symlinked cwd still normalizes repo-relative paths and detects anchored generatedPaths");

    // 10. Workspace-root file literally named "-" is searched as a file, not stdin
    writeFileSync(resolve(ws, "-"), "export const dashHit = 'dash_file_needle';\n");
    const dashRes = (await runGrep({ pattern: "dash_file_needle", path: "-", literal: true })).content[0].text;
    assert.match(dashRes, /scan: complete \| display: full .* 1 match in 1 file/, "file literally named '-' is searched via ./-");

    // 11. Nested contextDir inside searched workspace subdirectory still excludes its grep spill dir
    const nestedCtx = resolve(ws, "src/nested-ctx");
    mkdirSync(resolve(nestedCtx, "grep/s1"), { recursive: true });
    writeFileSync(resolve(nestedCtx, "grep/s1/001.txt"), "nested_spill_secret_needle\n");
    writeFileSync(resolve(ws, "src/real.txt"), "nested_real_needle\n");
    const { customTools: nestedTools } = await createAgentTools({ run: { id: "grep-nested" }, cwd: ws, contextDir: nestedCtx, tools: ["read", "grep"], scoped: { mode: "review" }, log: logger }, 0);
    const nestedGrep = nestedTools.find((t) => t.name === "grep");
    const nestedSpillRes = (await nestedGrep.execute("n1", { pattern: "nested_spill_secret_needle", path: "src", glob: "*.txt", literal: true }, undefined, undefined, {})).content[0].text;
    assert.match(nestedSpillRes, /0 matches/, "nested contextDir/grep inside searched subdir stays excluded");

    // 12. Long secret redacted before match keeps preview centered on the match
    const longTok = "github_pat_" + "A".repeat(420);
    writeFileSync(resolve(ws, "src/secret-line.ts"), `const k = "${longTok}"; const hit = "REDACT_SHIFTED_NEEDLE"; ${"z".repeat(400)}\n`);
    const redactedHit = (await runGrep({ pattern: "REDACT_SHIFTED_NEEDLE", path: "src/secret-line.ts", literal: true })).content[0].text;
    assert.match(redactedHit, /REDACT_SHIFTED_NEEDLE/, "match stays visible after preceding long secret is redacted");
    assert.doesNotMatch(redactedHit, /github_pat_AAA/, "secret remains redacted");
  } },
  phase1_optimizations: { title: "Phase 1 pre-injects diffStat, deduplicates live unchanged reads safely across compaction, guards bash git diff against lockfile bloat, and re-runs prepare when prepareInputs change", configure: [configureResumePrepare, (config) => {
    config.d1.enabled = false;
    config.tools.readDedupMinBytes = 256;
  }], run: async () => {
    // 1. Pre-injected diffStat in PR review prompt
    branchOff("feat-stat", "src/app.ts", "export const value = 2;\n");
    f.addPr(1, "feat-stat", "human");
    await route();
    await success();
    const prReq = f.requests.find((r) => r.context.action === "review_pr");
    assert.match(prReq.context.diffStat, /src\/app\.ts\s*\|\s*2\s*\+-/, "PR review prompt pre-injects compact diffStat");

    // 2. Compaction-safe sha256 exact read dedup + deterministic bash git diff lockfile guard (even with d1 disabled)
    const { createAgentTools } = await f.app("tools.ts");
    const { logger } = await f.app("logging.ts");
    const ws = resolve("p1-ws"), ctxDir = resolve("p1-ctx");
    mkdirSync(resolve(ws, "src"), { recursive: true });
    mkdirSync(ctxDir, { recursive: true });
    git(ws, "init", "-b", "main");
    writeFileSync(resolve(ws, "src/big.ts"), Array.from({ length: 20 }, (_, i) => `export const line_${i} = "${"v".repeat(20)}";`).join("\n") + "\n");
    writeFileSync(resolve(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  'alpha@1.0.0':\n    resolution: {integrity: sha512-old}\n");
    git(ws, "add", "."); commit(ws, "init");
    writeFileSync(resolve(ws, "src/big.ts"), Array.from({ length: 20 }, (_, i) => `export const line_${i} = "${"w".repeat(20)}";`).join("\n") + "\n");
    writeFileSync(resolve(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n" + Array.from({ length: 120 }, (_, i) => `  'pkg-${i}@2.0.${i}':\n    resolution: {integrity: sha512-${"x".repeat(40)}}\n`).join(""));

    let liveIds = new Set();
    const { customTools } = await createAgentTools({
      run: { id: "p1-run" }, cwd: ws, contextDir: ctxDir, tools: ["read", "bash"],
      scoped: { mode: "change" }, log: logger, getLiveToolCallIds: () => liveIds,
    });
    const readTool = customTools.find((t) => t.name === "read");
    const bashTool = customTools.find((t) => t.name === "bash");

    const r1 = (await readTool.execute("call-1", { path: "src/big.ts" }, undefined, undefined, {})).content[0].text;
    assert.match(r1, /line_0/);
    liveIds.add("call-1");
    const r2 = (await readTool.execute("call-2", { path: "src/big.ts" }, undefined, undefined, {})).content[0].text;
    assert.match(r2, /^\[unchanged: identical \d+-byte read of src\/big\.ts is already in this session context/, "identical live read is deduplicated");
    // Compaction evicts call-1 -> must return full content again
    liveIds = new Set();
    const r3 = (await readTool.execute("call-3", { path: "src/big.ts" }, undefined, undefined, {})).content[0].text;
    assert.match(r3, /line_0/, "evicted read after compaction returns full content");
    liveIds.add("call-3");
    // File mutation changes sha256 -> must return updated content even though call-3 is live
    writeFileSync(resolve(ws, "src/big.ts"), Array.from({ length: 20 }, (_, i) => `export const line_${i} = "${"z".repeat(20)}";`).join("\n") + "\n");
    const r4 = (await readTool.execute("call-4", { path: "src/big.ts" }, undefined, undefined, {})).content[0].text;
    assert.match(r4, /zzzzzzzzzz/, "mutated file bypasses read dedup via sha256 check");

    const bashCtx = { sessionManager: { getSessionId: () => "p1-sess", getSessionFile: () => undefined } };
    const guardedDiff = (await bashTool.execute("b1", { command: "git diff" }, undefined, undefined, bashCtx)).content[0].text;
    assert.match(guardedDiff, /line_0 = "zzzzzzzzzz/, "bash git diff keeps regular source hunk verbatim");
    assert.doesNotMatch(guardedDiff, /sha512-xxxxx/, "bash git diff omits lockfile bloat deterministically");
    assert.match(guardedDiff, /generated\/lockfile diff omitted.*pkg-0@2\.0\.0|Added\/updated entries.*pkg-0@2\.0\.0[\s\S]*generated\/lockfile diff omitted/);
    const rawDiff = (await bashTool.execute("b2", { command: "git diff", raw: true }, undefined, undefined, bashCtx)).content[0].text;
    assert.match(rawDiff, /sha512-xxxxx/, "raw: true bypasses bash git diff lockfile guard");

    // 3. prepareInputsSignature skips duplicate post-agent prepare when unchanged, re-runs when package.json changes
    writeFileSync("prepare.log", "");
    f.addIssue(10, ["scrat"]); f.enqueue(10, "implement");
    await success();
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 1, "unchanged prepareInputs skips duplicate post-agent prepare");

    writeFileSync("prepare.log", "");
    f.addIssue(11, ["scrat"]); f.enqueue(11, "implement");
    f.script = [{ name: "write", args: { path: "package.json", content: '{"name":"changed"}\n' } }];
    await success();
    f.script = undefined;
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 2, "editing package.json re-runs post-agent prepare");
  } },
  phase2_optimizations: { title: "Phase 2 extracts Vitest/TS/ESLint/Knip failures deterministically without d1 RPCs, honors browser selector + modal-safe DOM scoping + XML sitemap summaries, compacts baselines.json, and runs store_changes concurrently", configure: [(config) => {
    config.d1.enabled = true;
    config.d1.bash.minChars = 400;
    config.d1.bash.maxOutputChars = 2400;
    config.d1.failureBlocks.enabled = true;
    config.d1.failureBlocks.skipD1OnMatch = true;
    config.tools.browser.sitemapSamplesPerGroup = 2;
  }], run: async () => {
    const prevToken = process.env.CODEX_LB_API_KEY, prevFetch = globalThis.fetch;
    process.env.CODEX_LB_API_KEY = "p2-test-token-12345";
    let d1RpcCount = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "https://codex.unblocklabs.ai/v1/decisions") return prevFetch(url, init);
      d1RpcCount++;
      const body = JSON.parse(init.body);
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.9 }]));
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const { distillCommandOutput } = await f.app("d1.ts");
      const { createBrowserTool } = await f.app("scoped-tools.ts");
      const { stageBaselines } = await f.app("storefront-site.ts");
      const { writeState } = await f.app("storefront.ts");
      const ctxDir = resolve("p2-ctx"); mkdirSync(ctxDir, { recursive: true });

      // 1. Structured failure-block extraction captures Vitest, TS, ESLint, and Knip errors past 120 noisy warnings with 0 d1 RPCs
      const mixedFailureLog = [
        "Running checks...",
        ...Array.from({ length: 120 }, (_, i) => `{"level":"warn","msg":"warning ${i}: noisy deprecation notice ${"x".repeat(40)}"}`),
        "FAIL src/orders.test.ts > applies discount",
        "AssertionError: expected 90 to equal 100",
        "    at src/orders.test.ts:19:5",
        "",
        "src/api/billing.ts(44,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "",
        "src/ui/cart.tsx",
        "  12:7  error  'unusedVar' is assigned a value but never used  @typescript-eslint/no-unused-vars",
        "",
        "Unused files (2)",
        "src/legacy/old.ts",
        "src/legacy/dead.ts",
        "",
        ...Array.from({ length: 40 }, (_, i) => ` ✓ passing-test-${i}.test.ts`),
        "Exit status 1",
      ].join("\n");
      const structRes = await distillCommandOutput({
        rawOutput: mixedFailureLog, command: "pnpm check", artifactPath: resolve(ctxDir, "struct.log"),
        minChars: 400, maxChars: 2400,
      });
      assert.equal(d1RpcCount, 0, "structured failure blocks skip d1 RPCs completely");
      assert.equal(structRes.filtered, true);
      assert.match(structRes.text, /\[structured failures:/);
      assert.match(structRes.text, /FAIL src\/orders\.test\.ts/);
      assert.match(structRes.text, /error TS2345/);
      assert.match(structRes.text, /@typescript-eslint\/no-unused-vars/);
      assert.match(structRes.text, /Unused files \(2\)/);
      assert.ok(structRes.text.length <= 2400, `structured summary respects maxChars: got ${structRes.text.length}`);

      // Benign `Error:` log lines in passing tests must NOT trigger skipD1OnMatch (must still invoke d1 so real failures aren't hidden)
      const benignErrLog = "START\n"
        + Array.from({ length: 60 }, (_, i) => `  Error: expected validation error ${i} ${"z".repeat(40)}`).join("\n")
        + "\npanic: real crash in middle of log\n"
        + Array.from({ length: 30 }, (_, i) => `step ${i}: trailing output ${"a".repeat(30)}`).join("\n");
      const benignRes = await distillCommandOutput({
        rawOutput: benignErrLog, command: "pnpm test", artifactPath: resolve(ctxDir, "benign.log"),
        minChars: 400, maxChars: 2400,
      });
      assert.equal(d1RpcCount, 1, "bare Error: log lines do not bypass d1");
      assert.match(benignRes.text, /\[d1 filtered:/);

      // Unstructured noisy log with no Vitest/TS/ESLint/Knip markers falls through to d1
      const unstructured = "START\n" + Array.from({ length: 80 }, (_, i) => `step ${i}: building artifact bundle ${"a".repeat(30)}`).join("\n") + "\nDONE";
      const d1Res = await distillCommandOutput({
        rawOutput: unstructured, command: "pnpm build", artifactPath: resolve(ctxDir, "unstruct.log"),
        minChars: 400, maxChars: 2400,
      });
      assert.equal(d1RpcCount, 2, "unstructured command output falls through to d1");
      assert.equal(d1Res.filtered, true);
      assert.match(d1Res.text, /\[d1 filtered:/);

      // 2. Browser action=text: honors selector, executes real domScopingScript against a DOM fixture, and summarizes XML sitemaps deterministically
      let curUrl = "https://shop.example.test/products/focus";
      let bodyText = "BIG HEADER NAV FOOTER BOILERPLATE";
      let selectorSeen = "";
      const makeNode = ({ tag, attrs = {}, style = {}, rect = { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }, innerText = "", children = [] }) => {
        const node = {
          nodeType: 1, tagName: tag.toUpperCase(), attrs, style, rect, innerText, children, parentElement: null,
          getAttribute: (k) => attrs[k] ?? null,
          hasAttribute: (k) => Object.hasOwn(attrs, k),
          getBoundingClientRect: () => rect,
          contains: (other) => {
            if (other === node) return true;
            return children.some((c) => c.contains(other));
          },
          matches: (sel) => sel.split(",").map((s) => s.trim()).some((part) => {
            if (part === tag.toLowerCase()) return true;
            if (part === "[role=main]") return attrs.role === "main";
            if (part === "[role=dialog]") return attrs.role === "dialog";
            if (part === "[role=alertdialog]") return attrs.role === "alertdialog";
            if (part === "[aria-modal=true]") return attrs["aria-modal"] === "true";
            if (part === "dialog[open]") return tag.toLowerCase() === "dialog" && Object.hasOwn(attrs, "open");
            if (part === "[role=banner]") return attrs.role === "banner";
            if (part === "[role=navigation]") return attrs.role === "navigation";
            if (part === "[role=contentinfo]") return attrs.role === "contentinfo";
            if (part.includes("cart-drawer")) return /cart-drawer/i.test(`${attrs.id ?? ""} ${attrs.class ?? ""}`);
            if (part.includes("cookie")) return /cookie/i.test(`${attrs.id ?? ""} ${attrs.class ?? ""}`);
            return false;
          }),
          closest: (sel) => {
            let cur = node;
            while (cur) { if (cur.matches(sel)) return cur; cur = cur.parentElement; }
            return null;
          },
        };
        for (const c of children) c.parentElement = node;
        return node;
      };
      const buildDoc = (nodes) => {
        const allNodes = [];
        const walk = (n) => { allNodes.push(n); for (const c of n.children) walk(c); };
        const body = makeNode({ tag: "body", children: nodes });
        walk(body);
        return {
          body,
          querySelector: (sel) => allNodes.find((n) => n !== body && n.matches(sel)) ?? null,
          querySelectorAll: (sel) => allNodes.filter((n) => n !== body && n.matches(sel)),
        };
      };
      const hiddenBackdrop = makeNode({
        tag: "div", style: { opacity: "0" },
        children: [makeNode({ tag: "div", attrs: { role: "dialog" }, innerText: "CLOSED SECRET MODAL" })],
      });
      let mockDoc = buildDoc([
        makeNode({ tag: "header", innerText: "BIG HEADER NAV" }),
        makeNode({ tag: "main", innerText: "Main Product: Focus $48" }),
        makeNode({ tag: "cart-drawer", innerText: "Cart Drawer: 1 item in cart" }),
        hiddenBackdrop,
        makeNode({ tag: "footer", innerText: "FOOTER BOILERPLATE" }),
      ]);
      const stubPage = {
        goto: async (u) => { curUrl = u; return { status: () => 200 }; },
        title: async () => "Shop",
        url: () => curUrl,
        innerText: async (sel) => { selectorSeen = sel; return sel === "#cart" ? "Cart subtotal $48" : bodyText; },
        evaluate: async (expr) => new Function("document", "getComputedStyle", "window", `return (${expr})`)(
          mockDoc,
          (el) => ({ display: "block", visibility: "visible", opacity: "1", ...el.style }),
          { innerWidth: 1280, innerHeight: 800 },
        ),
        screenshot: async () => {},
        innerHTML: async () => "<html></html>",
        waitForLoadState: async () => {},
        on: () => {}, off: () => {}, setViewportSize: async () => {},
        locator: () => ({ count: async () => 1 }),
        click: async () => {}, fill: async () => {}, selectOption: async () => {},
      };
      const { tool: browserTool, close } = createBrowserTool({
        settings: { navigationHosts: ["shop.example.test"], resourceHosts: [] }, contextDir: ctxDir, runId: "p2-run", sessionTag: "p2",
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        launch: async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => stubPage, close: async () => {} }), close: async () => {} }),
      });
      try {
        await browserTool.execute("g1", { action: "goto", url: "https://shop.example.test/products/focus" }, undefined, undefined, {});
        const selOut = (await browserTool.execute("t1", { action: "text", selector: "#cart" }, undefined, undefined, {})).content[0].text;
        assert.equal(selectorSeen, "#cart", "action=text honors selector");
        assert.equal(selOut, "Cart subtotal $48");

        const domOut = (await browserTool.execute("t2", { action: "text" }, undefined, undefined, {})).content[0].text;
        assert.match(domOut, /Main Product: Focus \$48[\s\S]*Cart Drawer: 1 item in cart/, "real domScopingScript keeps <main> + <cart-drawer>");
        assert.doesNotMatch(domOut, /BIG HEADER NAV|FOOTER BOILERPLATE/, "real domScopingScript strips header/footer chrome");
        assert.doesNotMatch(domOut, /CLOSED SECRET MODAL/, "closed modal under opacity:0 ancestor is excluded");

        // No-<main> SPA page with modal inside #root must not duplicate modal text
        mockDoc = buildDoc([
          makeNode({ tag: "header", innerText: "NAV CHROME" }),
          makeNode({ tag: "div", attrs: { id: "root" }, innerText: "SPA App\nOpen Dialog", children: [makeNode({ tag: "div", attrs: { role: "dialog" }, innerText: "Open Dialog" })] }),
        ]);
        const spaOut = (await browserTool.execute("t2b", { action: "text" }, undefined, undefined, {})).content[0].text;
        assert.equal(spaOut.split("Open Dialog").length - 1, 1, "overlay inside included SPA root is not duplicated");

        const rawOut = (await browserTool.execute("t3", { action: "text", raw: true }, undefined, undefined, {})).content[0].text;
        assert.equal(rawOut, bodyText, "raw: true bypasses DOM scoping");

        // XML sitemap with query string (?from=1&to=2), &amp; entity, and CDATA <loc> (0 d1 RPCs)
        const rpcBeforeSitemap = d1RpcCount;
        await browserTool.execute("g2", { action: "goto", url: "https://shop.example.test/sitemap.xml?from=1&to=2" }, undefined, undefined, {});
        bodyText = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
          + `<url><loc>https://shop.example.test/sitemap_products_1.xml?from=10&amp;to=20</loc></url>\n`
          + `<url><loc><![CDATA[https://shop.example.test/products/cdata-item]]></loc></url>\n`
          + Array.from({ length: 49 }, (_, i) => `<url><loc>https://shop.example.test/products/item-${i}</loc></url>`).join("\n")
          + "\n"
          + Array.from({ length: 10 }, (_, i) => `<url><loc>https://shop.example.test/collections/col-${i}</loc></url>`).join("\n")
          + "\n</urlset>";
        const mapOut = await browserTool.execute("t4", { action: "text" }, undefined, undefined, {});
        assert.equal(d1RpcCount, rpcBeforeSitemap, "XML sitemap summarization uses 0 d1 RPCs");
        assert.match(mapOut.content[0].text, /\[sitemap summary: 61 URLs across 3 group\(s\)\]/);
        assert.match(mapOut.content[0].text, /sitemap_products_1\.xml\?from=10&to=20/, "decodes &amp; in child sitemap query strings");
        assert.match(mapOut.content[0].text, /products\/cdata-item/, "extracts CDATA <loc> entries");
        assert.match(mapOut.content[0].text, /\/products\/\*: 50 — .* \(\+48 more\)/);
        assert.ok(mapOut.details.artifactPath && existsSync(mapOut.details.artifactPath), "full sitemap saved as escape hatch");

        // HTML challenge/error page at /sitemap.xml must NOT be misclassified as a sitemap
        bodyText = "<!doctype html><html><body>Access denied https://shop.example.test/a https://shop.example.test/b</body></html>";
        const htmlErrOut = (await browserTool.execute("t5", { action: "text" }, undefined, undefined, {})).content[0].text;
        assert.doesNotMatch(htmlErrOut, /\[sitemap summary:/, "HTML error page at /sitemap.xml is not misclassified as a sitemap");
      } finally { await close(); }

      // 3. Compact multi-line baselines.json hoists shared sha and handles per-device sha differences
      mkdirSync(resolve("data/storefront/audits/baselines/home"), { recursive: true });
      mkdirSync(resolve("data/storefront/audits/baselines/cart"), { recursive: true });
      writeFileSync(resolve("data/storefront/audits/baselines/home/desktop.png"), "d");
      writeFileSync(resolve("data/storefront/audits/baselines/home/mobile.png"), "m");
      writeFileSync(resolve("data/storefront/audits/baselines/cart/desktop.png"), "cd");
      writeFileSync(resolve("data/storefront/audits/baselines/cart/mobile.png"), "cm");
      await writeState("audits/baselines/index.json", {
        home: { url: "https://shop.example.test/", devices: { desktop: "abcdef1234567890", mobile: "abcdef1234567890" } },
        cart: { url: "https://shop.example.test/cart", devices: { desktop: "1111111aaaaaaaaa", mobile: "2222222bbbbbbbbb" } },
      });
      const written = {};
      await stageBaselines(ctxDir, async (_k, name, content) => { written[name] = content; }, "audits");
      assert.ok(written["baselines.json"].split("\n").length >= 5, "baselines.json emits one page per line so large manifests stay readable by read");
      const compact = JSON.parse(written["baselines.json"]);
      assert.equal(compact.baselinesDir, resolve(ctxDir, "baselines"));
      assert.equal(compact.pages.home.sha, "abcdef1");
      assert.equal(compact.pages.home.devices.desktop, "home/desktop.png");
      assert.deepEqual(compact.pages.cart.devices.desktop, { file: "cart/desktop.png", sha: "1111111" });
      assert.deepEqual(compact.pages.cart.devices.mobile, { file: "cart/mobile.png", sha: "2222222" });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevToken === undefined) delete process.env.CODEX_LB_API_KEY; else process.env.CODEX_LB_API_KEY = prevToken;
    }
  } },
  codemode: { title: "codemode runs sandboxed JS batching tools, bypasses read dedup inside scripts, enforces workspace confinement, redacts secrets, tracks path receipts, and respects per-action opt-out", configure: [(config) => {
    config.tools.readDedupMinBytes = 256;
    config.tools.codemode = { review: true, change: false, mode: "on", inlineBudget: 3000, maxWorkers: 2, models: false };
    config.workflows.label_items.enabled = true;
    for (const name of ["review_pr", "resolve_conflicts", "address_pr_feedback", "address_review"]) config.workflows[name].enabled = false;
  }], run: async () => {
    const seed = resolve("seed"), remote = resolve("remote.git");
    writeFileSync(resolve(seed, "src/big.ts"), `export const BIG_MARKER = "found-big-file";\n${"// pad line\n".repeat(40)}`);
    writeFileSync(resolve(seed, "src/other.ts"), 'export const OTHER = "from-codemode";\n');
    git(seed, "add", "."); commit(seed, "add codemode fixtures"); git(seed, "push", remote, "main");
    f.addIssue(1);
    await route();

    const code = [
      'const [big, grepOut, other] = await Promise.all([',
      '  tools.read({ path: "src/big.ts" }),',
      '  tools.grep({ pattern: "BIG_MARKER" }),',
      '  tools.read({ path: "src/other.ts" }),',
      ']);',
      'let escapeBlocked = false;',
      'try { await tools.read({ path: "/etc/passwd" }); } catch (e) { escapeBlocked = String(e.message).includes("outside the workspace"); }',
      'return {',
      '  bigHasMarker: big.includes("found-big-file") && !big.includes("[unchanged: identical"),',
      '  grepHasMarker: grepOut.includes("BIG_MARKER"),',
      '  otherHasMarker: other.includes("from-codemode"),',
      '  escapeBlocked,',
      '  secret: "Bearer codemode-secret-token-xyz",',
      '};',
    ].join("\n");

    f.script = [
      { name: "read", args: { path: "src/big.ts" } },
      { name: "read", args: { path: "src/big.ts" } },
      { name: "codemode", args: { code } },
    ];
    const done = await success();
    assert.equal(f.row(s.tasks, done.taskId).action, "review_issue");
    const reviewReqs = f.requests.filter((req) => req.context.action === "review_issue");
    assert.ok(reviewReqs.length >= 4, `expected >= 4 requests, got ${reviewReqs.length}`);
    const toolNames = reviewReqs[0].request.tools.map((t) => t.function?.name ?? t.name);
    assert.ok(toolNames.includes("codemode"), `expected codemode tool in review_issue, got ${toolNames.join(",")}`);

    const toolMessages = reviewReqs.at(-1).request.messages.filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    assert.equal(toolMessages.length, 3);
    assert.match(toolMessages[0], /found-big-file/, "first direct read returns full file");
    assert.match(toolMessages[1], /\[unchanged: identical /, "second identical direct read returns dedup stub");
    assert.match(toolMessages[2], /"bigHasMarker":\s*true/, "nested read inside codemode bypasses dedup and returns real content");
    assert.match(toolMessages[2], /"grepHasMarker":\s*true/, "nested grep inside codemode works");
    assert.match(toolMessages[2], /"otherHasMarker":\s*true/, "parallel read inside codemode works");
    assert.match(toolMessages[2], /"escapeBlocked":\s*true/, "workspace confinement enforced inside codemode");
    assert.doesNotMatch(toolMessages[2], /codemode-secret-token-xyz/, "secrets redacted from codemode output");
    assert.match(toolMessages[2], /Bearer \[redacted\]/, "redacted marker present in codemode output");
    assert.ok(done.result.paths.includes("src/big.ts") && done.result.paths.includes("src/other.ts"), `receipt paths tracked inside codemode: ${done.result.paths}`);

    // Verify per-action codemode: false (label_items) omits codemode from tools
    f.script = undefined;
    const { config: live } = await f.app("config.ts");
    assert.equal(live.workflows.label_items.codemode, false);
    const labelReqCountBefore = f.requests.length;
    branchOff("cm-pr", "src/app.ts", "export const value = 2;\n");
    f.addPr(2, "cm-pr", "human");
    await route();
    f.script = ['Low risk.\nSCRAT_LABELS: [{"category":"risk","name":"risk: low"}]\nSCRAT_STATUS: complete'];
    const labeled = await success();
    assert.equal(f.row(s.tasks, labeled.taskId).action, "label_items");
    const labelReqs = f.requests.slice(labelReqCountBefore).filter((req) => req.context.action === "label_items");
    assert.ok(labelReqs.length >= 1);
    const labelTools = labelReqs[0].request.tools.map((t) => t.function?.name ?? t.name);
    assert.ok(!labelTools.includes("codemode"), `label_items must omit codemode, got ${labelTools.join(",")}`);
  } },
  workflows: {
    title: "workflows enforce trustLocalScripts, preserve effect receipts across hash changes, guard uncertain Slack delivery, isolate skill-only runs, gate outcomes, serialize concurrency, paginate merged PRs, and typecheck scripts",
    seed: () => {
      mkdirSync("app/workflows/checkpoint-demo", { recursive: true });
      writeFileSync("app/workflows/checkpoint-demo/workflow.yaml", [
        "name: checkpoint-demo",
        "description: Tests step checkpointing, effect receipts, state null/update, and parallel sync throws",
        "enabled: false",
        "on:",
        "  manual: true",
        "permissions:",
        "  slack:",
        "    - post",
        "defaults:",
        "  provider: fixture",
        "  model: gpt-6.2-sol",
        "  thinkingLevel: low",
      ].join("\n") + "\n");
      writeFileSync("app/workflows/checkpoint-demo/run.ts", [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        'import type { WorkflowContext } from "../../src/workflow-ctx.ts";',
        'export default async function (ctx: WorkflowContext) {',
        '  if (ctx.trigger.input.mode === "state-and-parallel") {',
        '    ctx.state.set("nullable", null);',
        '    const gotNull = ctx.state.get("nullable");',
        '    const updated = ctx.state.update<number[]>("nums", (prev = []) => [...prev, 1]);',
        '    let siblingSettled = false;',
        '    let caughtSync = false;',
        '    try {',
        '      await ctx.parallel({',
        '        asyncSibling: async () => { await new Promise((r) => setTimeout(r, 20)); siblingSettled = true; return 1; },',
        '        syncBoom: () => { throw new Error("sync boom"); },',
        '      });',
        '    } catch (err) {',
        '      caughtSync = err instanceof Error && err.message === "sync boom";',
        '    }',
        '    return { gotNull, updated, siblingSettled, caughtSync };',
        '  }',
        '  if (ctx.trigger.input.mode === "uncertain-slack") {',
        '    return await ctx.slack.post({ key: "uncertain-key", channel: "C-WF", text: "Maybe sent" });',
        '  }',
        '  if (ctx.trigger.input.mode === "dup-effect") {',
        '    return await ctx.parallel({',
        '      a: () => ctx.slack.post({ key: "race-key", channel: "C-WF", text: "A" }),',
        '      b: () => ctx.slack.post({ key: "race-key", channel: "C-WF", text: "B" }),',
        '    });',
        '  }',
        '  const counterFile = String(ctx.trigger.input.counterFile);',
        '  const failFile = String(ctx.trigger.input.failFile);',
        '  const fetched = await ctx.step("fetch", { v: 1 }, async () => {',
        '    const prev = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;',
        '    writeFileSync(counterFile, String(prev + 1));',
        '    return { count: prev + 1 };',
        '  });',
        '  const posted = await ctx.slack.post({ key: "notify-once", channel: "C-WF", text: "Checkpoint hello" });',
        '  const done = await ctx.step("finish", { fetched }, async () => {',
        '    if (existsSync(failFile)) throw new Error("Simulated transient crash after step 1");',
        '    return { ok: true, count: fetched.count, ts: posted.ts };',
        '  });',
        '  return done;',
        '}',
      ].join("\n") + "\n");

      mkdirSync("local-workflows/skill-only", { recursive: true });
      writeFileSync("local-workflows/skill-only/workflow.yaml", [
        "name: skill-only",
        "description: Single-agent local workflow with workspace read",
        "enabled: false",
        "on:",
        "  manual: true",
        "permissions:",
        "  workspace:",
        "    - read",
        "defaults:",
        "  provider: fixture",
        "  model: gpt-6.2-sol",
        "  thinkingLevel: low",
        "  codemode: false",
      ].join("\n") + "\n");
      writeFileSync("local-workflows/skill-only/SKILL.md", "# Skill Only\nInspect src/app.ts and report SCRAT_STATUS: complete.\n");

      mkdirSync("local-workflows/no-workspace", { recursive: true });
      writeFileSync("local-workflows/no-workspace/workflow.yaml", [
        "name: no-workspace",
        "description: Single-agent local workflow without workspace read permission",
        "enabled: false",
        "on:",
        "  manual: true",
        "defaults:",
        "  provider: fixture",
        "  model: gpt-6.2-sol",
        "  thinkingLevel: low",
        "  codemode: false",
      ].join("\n") + "\n");
      writeFileSync("local-workflows/no-workspace/SKILL.md", "# No Workspace\nDo not read repository files.\n");

      mkdirSync("local-workflows/bad-local", { recursive: true });
      writeFileSync("local-workflows/bad-local/workflow.yaml", [
        "name: bad-local",
        "enabled: false",
        "on:",
        "  manual: true",
        "defaults:",
        "  provider: fixture",
        "  model: gpt-6.2-sol",
        "  thinkingLevel: low",
      ].join("\n") + "\n");
      writeFileSync("local-workflows/bad-local/run.ts", 'import { parse } from "yaml";\nexport default async function () { return parse("a: 1"); }\n');

      mkdirSync("app/workflows/type-error-demo", { recursive: true });
      writeFileSync("app/workflows/type-error-demo/workflow.yaml", [
        "name: type-error-demo",
        "enabled: false",
        "on:",
        "  manual: true",
        "defaults:",
        "  provider: fixture",
        "  model: gpt-6.2-sol",
        "  thinkingLevel: low",
      ].join("\n") + "\n");
      writeFileSync("app/workflows/type-error-demo/run.ts", [
        'import type { WorkflowContext } from "../../src/workflow-ctx.ts";',
        'export default async function (ctx: WorkflowContext) { return ctx.doesNotExist(); }',
      ].join("\n") + "\n");
    },
    configure: [(config) => {
      config.workflows = {
        ...config.workflows,
        directory: resolve("local-workflows"),
        "maintainer-sweep": {
          enabled: false,
          provider: "fixture",
          model: "gpt-6.2-sol",
          thinkingLevel: "low",
          codemode: false,
          config: { channel: "C-MAINT", minLinkedIssues: 2, issueLabels: ["maintainer-rfc"] },
        },
      };
    }],
    run: async () => {
      const { workflows } = await f.app("workflow-registry.ts");
      const { validateWorkflowDefinition } = await f.app("startup.ts");
      const { pollSchedules } = await f.app("schedule-source.ts");
      const { config: liveConfig } = await f.app("config.ts");
      const { GitHubRepository } = await f.app("github.ts");

      const msDef = workflows.find((w) => w.name === "maintainer-sweep");
      const skillDef = workflows.find((w) => w.name === "skill-only");
      const badDef = workflows.find((w) => w.name === "bad-local");
      assert.ok(msDef && !msDef.local, "maintainer-sweep should load as bundled workflow");
      assert.ok(skillDef && skillDef.local, "skill-only should load from local workflows.directory");
      assert.ok(badDef && badDef.local, "bad-local should load from local workflows.directory");
      assert.deepEqual(await validateWorkflowDefinition(msDef, liveConfig, { checkDisabled: true }), []);
      assert.deepEqual(await validateWorkflowDefinition(skillDef, liveConfig, { checkDisabled: true }), []);
      const badProblems = await validateWorkflowDefinition(badDef, liveConfig, { checkDisabled: true });
      assert.ok(badProblems.some((p) => /requires workflows\.trustLocalScripts: true/.test(p)), `expected trustLocalScripts error, got: ${badProblems.join("; ")}`);
      assert.ok(badProblems.some((p) => /must not import bare npm specifier "yaml"/.test(p)), `expected bare import error, got: ${badProblems.join("; ")}`);

      const checkError = (() => {
        try {
          execFileSync(process.execPath, [resolve("app/src/workflow-cli.ts"), "check", "type-error-demo"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return "";
        } catch (err) {
          return String(err.stderr ?? "") + String(err.stdout ?? "");
        }
      })();
      assert.match(checkError, /doesNotExist/, "workflow check must fail on TypeScript error in run.ts");

      const counterFile = resolve("step1.count");
      const failFile = resolve("fail-step2.flag");
      writeFileSync(failFile, "1");
      const cpTask = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { counterFile, failFile } });
      const firstRun = await f.runNextTask(undefined, cpTask.id);
      assert.ok(firstRun?.error, "first attempt should fail in step 2");
      assert.equal(f.row(s.subjects, cpTask.subjectId).state, "open", "failed workflow subject stays open for retry");
      assert.equal(readFileSync(counterFile, "utf8"), "1", "step 1 should have executed once");
      assert.equal(f.slack.calls.filter((c) => c.method === "chat.postMessage" && c.body.channel === "C-WF").length, 1);

      db.update(s.steps).set({ workflowHash: "stale-prior-deploy-hash" }).where(eq(s.steps.taskId, cpTask.id)).run();
      rmSync(failFile);
      tasks.retryTask(cpTask.id);
      const secondRun = await f.runNextTask(undefined, cpTask.id);
      assert.ok(secondRun && !secondRun.error, `retry should succeed, got ${secondRun?.error?.message}`);
      assert.equal(readFileSync(counterFile, "utf8"), "2", "compute step re-runs when workflowHash changes");
      assert.equal(f.slack.calls.filter((c) => c.method === "chat.postMessage" && c.body.channel === "C-WF").length, 1, "effect receipt MUST ignore workflowHash and never double-post Slack");
      assert.equal(secondRun.publication.status, "published");
      assert.equal(f.row(s.subjects, cpTask.subjectId).state, "closed", "completed workflow subject is closed");

      f.slack.down = true;
      const uncertainTask = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "uncertain-slack" } });
      const uncertainRun1 = await f.runNextTask(undefined, uncertainTask.id);
      assert.ok(uncertainRun1?.error && /HTTP 503/.test(uncertainRun1.error.message));
      f.slack.down = false;
      tasks.retryTask(uncertainTask.id);
      const uncertainRun2 = await f.runNextTask(undefined, uncertainTask.id);
      assert.ok(uncertainRun2?.error && /Uncertain Slack delivery/.test(uncertainRun2.error.message), `expected uncertain Slack error on retry 1, got ${uncertainRun2?.error?.message}`);
      tasks.retryTask(uncertainTask.id);
      const uncertainRun3 = await f.runNextTask(undefined, uncertainTask.id);
      assert.ok(uncertainRun3?.error && /Uncertain Slack delivery/.test(uncertainRun3.error.message), `uncertain Slack must stay blocked on retry 2, got ${uncertainRun3?.error?.message}`);
      assert.equal(f.slack.calls.filter((c) => c.body.text === "Maybe sent").length, 1, "must never double-post after uncertain 503");

      const dupEffTask = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "dup-effect" } });
      const dupEffRun = await f.runNextTask(undefined, dupEffTask.id);
      assert.ok(dupEffRun?.error && /Concurrent effect call with duplicate key/.test(dupEffRun.error.message), `expected duplicate effect key rejection, got ${dupEffRun?.error?.message}`);

      const spDry = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "state-and-parallel" }, dryRun: true });
      const spDryRun = await f.runNextTask(undefined, spDry.id);
      assert.ok(spDryRun && !spDryRun.error, spDryRun?.error?.message);
      assert.deepEqual(JSON.parse(spDryRun.result.text), { gotNull: null, updated: [1], siblingSettled: true, caughtSync: true });
      assert.equal(all(s.workflowState).length, 0, "dry-run state.set/update must not write SQLite");

      const spLive = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "state-and-parallel" } });
      const spLiveRun = await f.runNextTask(undefined, spLive.id);
      assert.ok(spLiveRun && !spLiveRun.error, spLiveRun?.error?.message);
      assert.deepEqual(JSON.parse(spLiveRun.result.text), { gotNull: null, updated: [1], siblingSettled: true, caughtSync: true });
      assert.equal(spLiveRun.publication.status, "not_needed", "workflow with no effects records not_needed");

      const serialA = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "state-and-parallel" } });
      const serialB = tasks.enqueueWorkflowRun("checkpoint-demo", { input: { mode: "state-and-parallel" } });
      db.update(s.tasks).set({ status: "running" }).where(eq(s.tasks.id, serialA.id)).run();
      assert.equal(tasks.claimTask(serialB.id), undefined, "same workflow must not run concurrently");
      db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, serialA.id)).run();
      db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, serialB.id)).run();

      f.reset(0, "normal");
      f.script = [
        { name: "read", args: { path: "src/app.ts" } },
        "Inspected src/app.ts successfully.\nSCRAT_STATUS: complete",
      ];
      const skillTask = tasks.enqueueWorkflowRun("skill-only", { input: { note: "hello" } });
      const skillRun = await f.runNextTask(undefined, skillTask.id);
      assert.ok(skillRun && !skillRun.error, `skill-only workflow failed: ${skillRun?.error?.message}`);
      assert.match(skillRun.result.text, /Inspected src\/app\.ts/);
      assert.equal(skillRun.publication.status, "not_needed");

      f.reset(0, "normal");
      const reqBeforeNoWs = f.requests.length;
      f.script = [
        { name: "read", args: { path: "src/app.ts" } },
        "No repo access confirmed.\nSCRAT_STATUS: complete",
      ];
      const noWsTask = tasks.enqueueWorkflowRun("no-workspace");
      const noWsRun = await f.runNextTask(undefined, noWsTask.id);
      assert.ok(noWsRun && !noWsRun.error, noWsRun?.error?.message);
      const noWsToolOutput = f.requests.slice(reqBeforeNoWs).at(-1).request.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
      assert.doesNotMatch(noWsToolOutput, /export const value = 1/, "skill-only workflow without workspace:read must not see repositoryPath");

      branchOff("merged-fix", "src/app.ts", "export const value = 42;\n");
      const oldClosed = new Date().toISOString();
      for (let i = 0; i < 105; i++) {
        f.addPr(300 + i, "merged-fix", "human", { state: "closed", merged_at: null, updated_at: oldClosed });
      }
      f.addPr(12, "merged-fix", "human", { state: "closed", merged_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      const pagedMerged = await new GitHubRepository("fixture/project").fetchRecentMergedPullRequests(7, 10);
      assert.ok(pagedMerged.some((pr) => pr.number === 12), "fetchRecentMergedPullRequests must paginate past page 1 unmerged closed PRs");

      f.addIssue(10, ["bug"], "Retry loop hangs on 503");
      f.addIssue(11, ["bug"], "Slack retry duplicates messages");

      const proposalPayload = {
        status: "complete",
        found: true,
        slug: "unified-retry",
        title: "RFC: Unified retry primitive",
        linkedNumbers: [10, 11, 12],
        summary: "Both issues duplicate backoff and idempotency handling.",
        evidence: [{ path: "src/app.ts", detail: "Duplicated retry loop" }],
        proposal: "## Problem\nDuplicated retry loops in #10 and #11.\n\n## Primitive\nAdd `withRetry()`.",
      };
      const critiquePayload = {
        status: "complete",
        approved: true,
        reason: "Verified src/app.ts and linked issues #10, #11.",
      };

      f.reset(0, "normal");
      f.script = [
        { name: "submit_result", args: { ...proposalPayload, status: "needs_decision" } },
        "Needs human decision.",
      ];
      const ndTask = tasks.enqueueWorkflowRun("maintainer-sweep");
      const ndRun = await f.runNextTask(undefined, ndTask.id);
      assert.ok(ndRun?.error, "needs_decision proposal must fail step and not publish");
      assert.equal(f.written("issue").length, 0);

      f.reset(0, "normal");
      f.script = [
        { name: "submit_result", args: { ...proposalPayload, linkedNumbers: [999, 998] } },
        "Submitted with bogus IDs.",
      ];
      const bogusTask = tasks.enqueueWorkflowRun("maintainer-sweep");
      const bogusRun = await f.runNextTask(undefined, bogusTask.id);
      assert.ok(bogusRun && !bogusRun.error);
      assert.equal(JSON.parse(bogusRun.result.text).status, "rejected_threshold", "hallucinated linkedNumbers must be rejected");

      f.reset(0, "normal");
      const reqBeforeDry = f.requests.length;
      f.script = [
        { name: "submit_result", args: { status: "complete", found: true, slug: "BAD_SLUG" } },
        "Malformed found:true submission.",
        { name: "submit_result", args: { ...proposalPayload, status: "incomplete" } },
        "Partial draft.",
        "Forgot to call submit_result on continuation!",
        { name: "submit_result", args: proposalPayload },
        "Draft RFC submitted for critique.",
        { name: "read", args: { path: "src/app.ts" } },
        { name: "submit_result", args: critiquePayload },
        "Critique approved the RFC.",
      ];
      const dryTask = tasks.enqueueWorkflowRun("maintainer-sweep", { dryRun: true });
      const dryRun = await f.runNextTask(undefined, dryTask.id);
      assert.ok(dryRun && !dryRun.error, `maintainer-sweep dry-run failed: ${dryRun?.error?.message}`);
      const dryOut = JSON.parse(dryRun.result.text);
      assert.equal(dryOut.status, "dry_run");
      assert.ok(dryOut.issue.previewPath && existsSync(dryOut.issue.previewPath));
      assert.ok(dryOut.slack.previewPath && existsSync(dryOut.slack.previewPath));
      assert.equal(f.written("issue").length, 0);
      assert.equal(f.slack.calls.filter((c) => c.body.channel === "C-MAINT").length, 0);
      const dryReqs = f.requests.slice(reqBeforeDry);
      assert.ok(dryReqs.some((r) => JSON.stringify(r.request.messages).includes("Call the submit_result tool")), "stale submittedData must be cleared on continuation so omitting submit_result triggers correction");
      assert.ok(dryReqs.some((r) => JSON.stringify(r.request.messages).includes("Retry loop hangs on 503") && JSON.stringify(r.request.messages).includes("Maintainer RFC Critique")), "critic must receive linked issues");

      f.reset(0, "normal");
      f.script = [
        { name: "submit_result", args: proposalPayload },
        "Draft RFC submitted.",
        { name: "submit_result", args: critiquePayload },
        "Critique approved.",
      ];
      const liveTask = tasks.enqueueWorkflowRun("maintainer-sweep");
      const liveRun = await f.runNextTask(undefined, liveTask.id);
      assert.ok(liveRun && !liveRun.error, `maintainer-sweep live run failed: ${liveRun?.error?.message}`);
      const liveOut = JSON.parse(liveRun.result.text);
      assert.equal(liveOut.status, "opened");
      assert.equal(liveRun.publication.status, "published");
      assert.equal(f.written("issue").length, 1);
      const openedIssue = f.issues.get(liveOut.issue.number);
      assert.ok(openedIssue.labels.some((l) => l.name === "maintainer-rfc"));
      assert.match(openedIssue.body, /<!-- scrat-fingerprint:workflow:maintainer-sweep:rfc-unified-retry -->/);
      assert.equal(f.slack.calls.filter((c) => c.body.channel === "C-MAINT").length, 1);

      f.reset(0, "normal");
      f.script = [
        { name: "submit_result", args: proposalPayload },
        "Same RFC again.",
      ];
      const dupTask = tasks.enqueueWorkflowRun("maintainer-sweep");
      const dupRun = await f.runNextTask(undefined, dupTask.id);
      assert.ok(dupRun && !dupRun.error);
      assert.equal(JSON.parse(dupRun.result.text).status, "already_proposed");
      assert.equal(f.written("issue").length, 1);

      liveConfig.workflows["maintainer-sweep"].enabled = true;
      const before = new Date("2026-10-18T12:00:00Z");
      const after = new Date("2026-10-19T14:00:00Z");
      assert.equal(await pollSchedules("fixture/project", before), 0);
      assert.equal(await pollSchedules("fixture/project", after), 1);
      const cronTask = all(s.tasks).find((t) => t.action === "maintainer-sweep" && t.status === "queued" && t.input.kind === "tick");
      assert.ok(cronTask, "cron tick must be enqueued");
      f.reset(0, "normal");
      f.script = [
        { name: "submit_result", args: { status: "complete", found: false, summary: "No new shared root cause." } },
        "No RFC this week.",
      ];
      const cronRun = await f.runNextTask(undefined, cronTask.id);
      assert.ok(cronRun && !cronRun.error, `cron-triggered workflow run failed: ${cronRun?.error?.message}`);
      assert.equal(JSON.parse(cronRun.result.text).status, "no_rfc");
    },
  },
  workflow_replay: {
    title: "workflow replay freezes journaled model calls across prompt edits, pins the checkout and previews effects on a CLI-only task",
    configure: [(config) => {
      config.workflows["maintainer-sweep"].config = { channel: "C-REPLAY", minLinkedIssues: 3 };
      process.env.SLACK_BOT_TOKEN = ["xoxb", "1234567890", "fixtureSlackToken"].join("-");
    }],
    run: async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execute = promisify(execFile);
      const modelOrigin = new URL(f.config.providers.fixture.baseUrl).origin;
      const outbound = resolve("replay-outbound.jsonl");
      const preload = resolve("replay-transport.mjs");
      writeFileSync(preload, `import { appendFileSync } from "node:fs";
        const fixtureFetch = globalThis.fetch;
        globalThis.fetch = (input, options) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          if (url.origin !== ${JSON.stringify(modelOrigin)}) {
            appendFileSync(${JSON.stringify(outbound)}, JSON.stringify({ url: url.href, method: options?.method }) + "\\n");
            throw new Error("Unexpected outbound workflow request");
          }
          return fixtureFetch(input, options);
        };`);
      const cli = (...args) => execute(process.execPath, ["--import", preload, resolve("app/src/workflow-cli.ts"), ...args]);
      const rowsFor = (taskId) => all(s.steps).filter((step) => step.taskId === taskId);
      const parseInspection = async (...args) => JSON.parse((await cli("inspect", ...args, "--json")).stdout);
      const proposal = { name: "submit_result", args: { status: "complete", found: true, slug: "replay-retry", title: "RFC: Retry handling",
        linkedNumbers: [10, 11, 12], proposal: "Use one retry policy for requests to upstream services." } };
      const approve = { name: "submit_result", args: { status: "complete", approved: true, reason: "Verified all three issues." } };
      const fail = { name: "submit_result", args: { status: "needs_decision", approved: false, reason: "Need maintainer decision." } };
      for (const number of proposal.args.linkedNumbers) f.addIssue(number, ["bug"], `Retry failure ${number}`);
      const task = tasks.enqueueWorkflowRun("maintainer-sweep", { input: { topic: "original", keep: true } });
      f.script = [proposal, "Proposal submitted.", fail, "Cannot finish critique."];
      const first = await f.runNextTask(undefined, task.id);
      assert.match(first.error?.message, /Critique agent did not complete/);
      assert.match((await cli("replay", first.id, "--from", "critique", "--plan")).stdout, /FROZEN\tgather, propose\nFRESH\tcritique/);

      tasks.retryTask(task.id);
      f.reset(0, "normal");
      f.script = [approve, "Critique approved."];
      const original = await f.runNextTask(undefined, task.id);
      assert.equal(original.error, null, original.error?.message);
      assert.equal(original.publication.status, "published");
      assert.ok(original.headSha);
      assert.equal(f.written("issue").length, 1);
      assert.equal(f.slack.calls.filter((call) => call.method === "chat.postMessage" && call.body.channel === "C-REPLAY").length, 1);
      const earlier = await cli("inspect", first.id, "--json");
      assert.match(earlier.stderr, /journal reflects run/);
      assert.equal(JSON.parse(earlier.stdout).latestRunId, original.id);
      assert.equal(JSON.parse(earlier.stdout).status, "failed");

      const state = all(s.workflowState);
      assert.ok(state.some((row) => row.workflow === "maintainer-sweep"));
      const originalRows = rowsFor(task.id);
      const baseline = await parseInspection(task.id);
      assert.equal(baseline.runId, original.id);
      assert.equal(baseline.triggerKind, "workflow_manual");
      assert.deepEqual(baseline.steps.map((step) => step.name), ["gather", "propose", "critique"]);
      assert.equal(baseline.effects.length, 2);
      assert.ok(baseline.steps.every((step) => step.drift === false && step.durationMs >= 0 && step.outputBytes > 0));
      assert.deepEqual(JSON.parse((await cli("inspect", task.id, "--step", "propose")).stdout), originalRows.find((step) => step.name === "propose").output);
      const critiquePath = resolve("app/workflows/maintainer-sweep/CRITIQUE.md");
      writeFileSync(critiquePath, readFileSync(critiquePath, "utf8") + "\nReplay-specific critique instructions.\n");
      changeMain("src/app.ts", "export const value = 101;\n");
      assert.notEqual(git(resolve("remote.git"), "rev-parse", "main"), original.headSha);
      assert.match((await cli("inspect", original.id)).stdout, /propose\tcompleted\t\d+ms\t\w{8}\t\w{8}\tDRIFT/);

      const counts = () => [all(s.tasks).length, all(s.runs).length, f.requests.length, f.writes.length, f.slack.calls.length];
      const beforePlan = counts();
      assert.match((await cli("replay", original.id, "--plan")).stdout, /FROZEN\tgather, propose, critique\nFRESH\t\(none\)/);
      await assert.rejects(cli("replay", original.id, "--from", "unknown", "--plan"), { stderr: /available: gather, propose, critique/ });
      await assert.rejects(cli("replay", original.id, "--input", "[]", "--plan"), { stderr: /--input must be a JSON object/ });
      await assert.rejects(cli("replay", original.id, "--live"), { stderr: /Unknown option '--live'/ });
      assert.deepEqual(counts(), beforePlan);

      let cliOwner;
      f.onModel = () => {
        const running = all(s.tasks).find((row) => row.input.replayOf === original.id && row.status === "running");
        const pidFile = running && resolve("data/cli-tasks", `${running.id}.pid`);
        if (pidFile && existsSync(pidFile)) cliOwner = { id: running.id, pid: Number(readFileSync(pidFile, "utf8")) };
      };
      f.reset(0, "normal");
      f.script = [approve, "Critique reran."];
      const completed = await cli("replay", original.id, "--from", "critique", "--dry-run", "--input", '{"topic":"updated","replayOf":"not-a-run","dryRun":false}');
      f.onModel = undefined;
      const replayId = /^COMPLETED\t([^\t\n]+)\t/m.exec(completed.stdout)?.[1];
      assert.ok(replayId, completed.stdout);
      const replay = f.row(s.runs, replayId), replayTask = f.row(s.tasks, replay.taskId);
      assert.equal(replay.sequence, original.sequence + 1);
      assert.equal(replay.headSha, original.headSha);
      assert.equal(replay.publication.status, "not_needed");
      assert.ok(cliOwner?.pid > 0 && cliOwner.id === replayTask.id, "CLI owns the running task through its PID file");
      assert.equal(existsSync(resolve("data/cli-tasks", `${replayTask.id}.pid`)), false);
      assert.equal(replayTask.status, "completed");
      assert.deepEqual(replayTask.input, { ...task.input, replayOf: original.id,
        payload: { topic: "updated", keep: true, replayOf: "not-a-run", dryRun: false } });
      assert.notEqual(replayTask.subjectId, task.subjectId);
      assert.equal(f.row(s.subjects, replayTask.subjectId).kind, "workflow");
      assert.match(f.row(s.subjects, replayTask.subjectId).key, /^maintainer-sweep:replay:/);
      const modelRequests = f.requests.slice(beforePlan[2]);
      assert.ok(modelRequests.length > 0);
      assert.ok(modelRequests.every((request) => JSON.stringify(request.request.messages).includes("Replay-specific critique instructions.")), "only the edited critique reached the model");
      assert.match(completed.stderr, /"event":"workflow.step_frozen".*"step":"propose"/);
      const replayInspection = await parseInspection(replayId, "--step", "critique");
      assert.equal(replayInspection.step.output.data.approved, true);
      assert.equal(replayInspection.step.drift, false);
      assert.equal(replayInspection.effects.length, 0);
      const replayRows = rowsFor(replayTask.id);
      for (const name of ["gather", "propose"]) {
        assert.deepEqual(replayRows.find((step) => step.name === name), { ...originalRows.find((step) => step.name === name), taskId: replayTask.id });
      }
      assert.notEqual(replayInspection.step.workflowHash, baseline.steps.find((step) => step.name === "critique").workflowHash);
      const preview = /^PREVIEW\t(.+)$/m.exec(completed.stdout)?.[1];
      assert.equal(preview, resolve("data/workflow-dry-runs", `maintainer-sweep-${replayId.slice(0, 8)}`));
      const result = JSON.parse(replay.result.text);
      assert.deepEqual([result.issue.previewPath, result.slack.previewPath].map((path) => JSON.parse(readFileSync(path, "utf8")).runId), [replayId, replayId]);

      f.reset(0, "normal");
      f.script = [fail, "Critique did not complete."];
      const failed = await cli("replay", replayId, "--from", "critique").then(() => assert.fail("Replay unexpectedly succeeded"), (error) => error);
      const failedId = /^FAILED\t([^\t\n]+)\t/m.exec(failed.stderr)?.[1];
      assert.ok(failedId, failed.stderr);
      const failedRun = f.row(s.runs, failedId), failedTask = f.row(s.tasks, failedRun.taskId);
      assert.equal(failedTask.status, "failed");
      assert.ok(failedRun.finishedAt);
      assert.equal(existsSync(resolve("data/cli-tasks", `${failedTask.id}.pid`)), false);
      tasks.retryTask(failedTask.id);
      assert.equal(tasks.claimTask(failedTask.id), undefined);
      assert.equal(f.row(s.tasks, failedTask.id).status, "failed");
      assert.ok(all(s.events).some((event) => event.taskId === failedTask.id && event.type === "task.rejected" && /replay CLI/.test(event.data.reason)));
      assert.deepEqual(rowsFor(task.id), originalRows);
      assert.deepEqual(all(s.workflowState), state);
      assert.deepEqual([f.writes.length, f.slack.calls.length], beforePlan.slice(3));
      assert.equal(existsSync(outbound), false, "replay process attempted no GitHub or Slack calls");

      f.script = undefined;
      const managedTask = f.enqueue(10);
      const managed = await f.runNextTask(undefined, managedTask.id);
      assert.ok(managed && !managed.error);
      await assert.rejects(cli("replay", managed.id, "--plan"), { stderr: /managed-pipeline workflows are not replayable/ });
    },
  },
  workflow_repo_sync: {
    title: "workflow sync verifies pinned Git bundles and overlays before switching current, with safe offline reuse and retention",
    run: async () => {
      const local = resolve("app/scrat.local.json");
      const base = JSON.parse(readFileSync(local, "utf8"));
      const source = resolve("workflow-source");
      execFileSync("git", ["init", "-b", "main", source], { stdio: "ignore" });
      const pointer = resolve("data/workflows-repo/current");
      const checkout = (sha) => resolve("data/workflows-repo/checkouts", sha);
      const cli = (...args) => {
        const result = spawnSync(process.execPath, [resolve("app/src/workflow-cli.ts"), ...args], { encoding: "utf8" });
        assert.ifError(result.error);
        return result;
      };
      const ok = (...args) => {
        const result = cli(...args);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const reject = (...args) => {
        const result = cli(...args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        return result.stdout + result.stderr;
      };
      const setRepo = (repo, extra = {}) => writeFileSync(local, JSON.stringify({ ...base, workflows: { ...base.workflows, repo, trustLocalScripts: true, ...extra } }));
      const pin = (ref, extra, repo = {}) => setRepo({ url: source, ref, layers: ["shared", "clients/x"], keepCheckouts: 1, ...repo }, extra);
      const workflow = (layer, name, label, override, script) => {
        const dir = resolve(layer, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, "workflow.yaml"), [
          `name: ${name}`, `description: ${label}`, "mode: review", "on: {manual: true}",
          "defaults: {provider: fixture, model: gpt-6.2-sol, thinkingLevel: high}", ...(override ? ["override: true"] : []), "",
        ].join("\n"));
        if (script === undefined) writeFileSync(resolve(dir, "SKILL.md"), `# ${label}\n`);
        else writeFileSync(resolve(dir, "run.ts"), `import type { WorkflowContext } from "scrat";\nexport default async (ctx: WorkflowContext) => ${script};\n`);
      };
      const save = (label) => {
        git(source, "add", ".");
        commit(source, label);
        return git(source, "rev-parse", "HEAD");
      };
      const shared = resolve(source, "shared"), client = resolve(source, "clients/x");
      const listed = (name) => ok("list").split("\n").find((line) => line.startsWith(`${name}\t`)).split("\t");
      assert.match(ok("sync"), /No workflows.repo configured/);
      assert.equal(listed("review_issue").at(-1), "builtin");
      workflow(shared, "review_issue", "Shared review", true);
      workflow(shared, "shared_only", "Shared only");
      workflow(client, "review_issue", "Client review", true, "ctx.workflow.name");
      const first = save("Valid shared and client layers");
      for (const [repo, field] of [[{ url: " " }, "url"], [{ ref: "main" }, "ref"], [{ layers: [] }, "layers"],
        [{ layers: ["shared/../clients/x"] }, "layers"], [{ layers: ["/shared"] }, "layers"], [{ layers: ["C:\\shared"] }, "layers"],
        [{ keepCheckouts: 0 }, "keepCheckouts"], [{ keepCheckouts: 1.5 }, "keepCheckouts"], [{ unknown: true }, "unknown"]]) {
        pin(first, {}, repo);
        assert.ok(reject("sync").includes(`workflows.repo.${field}`));
        assert.ok(reject("list").includes(`workflows.repo.${field}`));
      }
      pin(first.toUpperCase());
      assert.match(reject("list"), /run "npm run workflow -- sync"/);
      assert.match(ok("sync"), new RegExp(`\\(none\\) -> ${first}.*Restart scrat.service`));
      assert.equal(fs.readlinkSync(pointer), `checkouts/${first}`);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));
      assert.deepEqual(listed("review_issue").slice(-2), ["Client review", "repo:clients/x"]);
      assert.deepEqual(listed("shared_only").slice(-2), ["Shared only", "repo:shared"]);
      const localDir = resolve("local-workflows");
      workflow(localDir, "review_issue", "Local review");
      pin(first, { directory: localDir });
      assert.deepEqual(listed("review_issue").slice(-2), ["Local review", "directory"]);
      pin(first, { trustLocalScripts: false });
      assert.match(reject("sync"), /requires workflows.trustLocalScripts: true/);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));
      pin(first);
      fs.renameSync(source, `${source}-offline`);
      assert.match(ok("sync"), new RegExp(`already synced at ${first}`));
      fs.renameSync(`${source}-offline`, source);

      workflow(client, "review_issue", "Missing override", false, "ctx.workflow.name");
      const duplicate = save("Duplicate without override");
      pin(duplicate);
      assert.match(reject("list"), new RegExp(`expected ${duplicate}; run "npm run workflow -- sync"`));
      const duplicateError = reject("sync");
      assert.ok(duplicateError.includes(`${checkout(duplicate)}/shared/review_issue/workflow.yaml`));
      assert.ok(duplicateError.includes(`${checkout(duplicate)}/clients/x/review_issue/workflow.yaml`));
      assert.match(duplicateError, /set override: true/);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));

      workflow(client, "review_issue", "Broken script", true, "ctx.doesNotExist");
      workflow(client, "stale_override", "Stale override", true);
      const stale = save("Stale override");
      pin(stale);
      assert.match(reject("sync"), /stale_override\/workflow.yaml: override: true requires a workflow in a lower layer/);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));
      rmSync(resolve(client, "stale_override"), { recursive: true });
      const broken = save("Script type error");
      pin(broken);
      assert.match(reject("sync"), /Property 'doesNotExist' does not exist on type 'WorkflowContext'/);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));

      workflow(client, "review_issue", "Second client review", true, "ctx.workflow.name");
      symlinkSync("../../shared/shared_only/SKILL.md", resolve(client, "review_issue", "linked-skill.md"));
      const linked = save("Symlink inside a bundle");
      pin(linked);
      assert.match(reject("sync"), /contains a symlink: .*linked-skill.md/);
      assert.equal(existsSync(checkout(linked)), false);
      assert.equal(realpathSync(pointer), realpathSync(checkout(first)));
      unlinkSync(resolve(client, "review_issue", "linked-skill.md"));
      const second = save("Second valid client layer");
      pin(second);
      assert.match(ok("sync"), new RegExp(`${first} -> ${second}.*Restart scrat.service`));
      assert.equal(fs.readlinkSync(pointer), `checkouts/${second}`);
      assert.equal(realpathSync(pointer), realpathSync(checkout(second)));
      assert.equal(existsSync(checkout(first)), true, "retention protects the previous checkout even at keepCheckouts=1");
      assert.deepEqual(listed("review_issue").slice(-2), ["Second client review", "repo:clients/x"]);
      assert.equal(existsSync(checkout(broken)), false);
      assert.match(ok("sync"), /already synced/);
      assert.equal(existsSync(checkout(first)), true, "idempotent sync still protects the previous checkout");

      workflow(client, "review_issue", "Third client review", true, "ctx.workflow.name");
      const third = save("Third valid client layer");
      pin(third);
      assert.match(ok("sync"), new RegExp(`${second} -> ${third}`));
      assert.equal(realpathSync(pointer), realpathSync(checkout(third)));
      assert.equal(existsSync(checkout(second)), true);
      assert.equal(existsSync(checkout(first)), false);
    },
  },
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = Object.hasOwn(scenarios, scenario) ? scenarios[scenario] : undefined;
  if (!spec) throw new Error("Unknown scenario " + scenario);
  f = await fixture(scenario, spec);
  ({ db, schema: s, tasks, git, commit } = f);
  try {
    await spec.run();
    console.log("SCENARIO_PASSED " + scenario);
  } finally { await f.close(); }
}
