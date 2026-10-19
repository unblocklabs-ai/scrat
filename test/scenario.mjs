import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "./fixture.mjs";

const scenario = process.argv[2];
const f = await fixture(scenario);
const { db, schema: s, tasks, git, commit } = f;
const all = (table) => db.select().from(table).all();
const route = async () => (await f.app("github-sync.ts")).syncGitHub();
const run = async () => { const r = await f.runNextTask(); assert.ok(r); return r; };
const success = async () => { const r = await run(); assert.equal(r.error, null, JSON.stringify(r.error)); return r; };
const implement = async (n) => { f.addIssue(n, ["scrat"]); f.enqueue(n, "implement"); return success(); };
const changeMain = (path, text) => {
  writeFileSync(resolve("seed", path), text); git(resolve("seed"), "add", "."); commit(resolve("seed"), "Change " + path);
  git(resolve("seed"), "push", resolve("remote.git"), "main");
};
try {
  if (scenario === "queue") {
    for (let n = 1; n <= 9; n++) f.addIssue(n);
    f.enqueue(1); f.enqueue(2, "implement"); const first = f.enqueue(3, "review_pr", { version: 1 });
    const coalesced = f.enqueue(3, "review_pr", { version: 2 });
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
    const w = await createWorkspace({ repositoryPath: f.config.github.repositoryPath });
    const { eq } = await import("drizzle-orm");
    db.update(s.items).set({ workspaceId: w.id }).where(eq(s.items.id, "issue-8")).run();
    db.update(s.items).set({ workspaceId: w.id }).where(eq(s.items.id, "issue-9")).run();
    const claimed = []; let next; while ((next = tasks.claimTask())) claimed.push(next);
    assert.equal(claimed.filter((c) => ["issue-8", "issue-9"].includes(c.item.id)).length, 1);
  } else if (scenario === "repository_sync") {
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
      if (url.hostname === "api.github.com") {
        const token = new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
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
      assert.equal(all(s.githubSnapshots)[0].items.find((item) => item.number === 1).diagnosticOnly.retained, true);
      const count = (permission) => exchanges.filter((exchange) => JSON.stringify(exchange.permissions) === JSON.stringify(permission)).length;
      const read = { issues: "read", pull_requests: "read", metadata: "read" }, contents = { contents: "read", metadata: "read" };
      assert.equal(count(read), 1); assert.equal(count(contents), 1);
      await route(); assert.equal(count(read), 1); assert.equal(count(contents), 1);
      mock.timers.enable({ apis: ["Date"], now: Date.now() });
      // Keep time monotonic until all cached clients have finished their work.
      mock.timers.tick(60 * 60 * 1000);
      await route(); assert.equal(count(read), 2); assert.equal(count(contents), 2);
      // Exercise real publication with distinct contents-write and PR scopes.
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
  } else if (scenario === "routing") {
    f.addIssue(1); f.addIssue(2, ["scrat"]); await route();
    const queued = () => all(s.tasks).filter((t) => t.status === "queued");
    assert.deepEqual(queued().map((t) => t.action).sort(), ["implement", "review_issue"]);
    await route(); assert.equal(queued().length, 2);
    f.issues.get(1).labels.push({ name: "scrat" }); f.issues.get(2).labels = []; await route();
    assert.deepEqual(queued().map((t) => [t.itemId, t.action]).sort(), [["issue-1", "implement"], ["issue-2", "review_issue"]]);
    git(resolve("seed"), "switch", "-c", "scrat/routing");
    writeFileSync("seed/src/app.ts", "export const value = 2;\n"); git(resolve("seed"), "add", "."); commit(resolve("seed"), "PR branch");
    git(resolve("seed"), "push", resolve("remote.git"), "scrat/routing"); git(resolve("seed"), "switch", "main");
    changeMain("src/app.ts", "export const value = 3;\n");
    f.prs.push({ ...f.issues.get(1), id: 201, node_id: "PR_routing", number: 201,
      html_url: "https://github.com/fixture/project/pull/201", body: "Closes #1", labels: [], user: { login: f.config.github.botLogin },
      head: { ref: "scrat/routing", sha: git(resolve("remote.git"), "rev-parse", "scrat/routing"), repo: { full_name: "fixture/project" } },
      base: { ref: "main", repo: { full_name: "fixture/project" } },
    });
    const external = { id: 9001, body: "Please explain this change", user: { login: "human" }, updated_at: "2026-10-19T01:00:00Z", html_url: "https://github.com/fixture/project/pull/201#comment" };
    f.comments.set(201, [external, { ...external, id: 9002, body: "My own review", user: { login: f.config.github.botLogin } }]);
    await route();
    assert.ok(!queued().some((t) => t.itemId === "issue-1"));
    const prTasks = () => queued().filter((t) => f.row(s.items, t.itemId).kind === "pr");
    assert.deepEqual(prTasks().map((t) => t.action).sort(), ["address_pr_feedback", "resolve_conflicts", "review_pr"]);
    const conflict = prTasks().find((t) => t.action === "resolve_conflicts"), feedback = prTasks().find((t) => t.action === "address_pr_feedback");
    assert.deepEqual(feedback.input.commentRevisions, ["issue:9001@2026-10-19T01:00:00Z"]);
    changeMain("src/app.ts", "export const value = 4;\n");
    external.updated_at = "2026-10-19T02:00:00Z"; await route();
    assert.equal(prTasks().find((t) => t.action === "resolve_conflicts").id, conflict.id);
    assert.notEqual(prTasks().find((t) => t.action === "resolve_conflicts").input.mainSha, conflict.input.mainSha);
    assert.equal(prTasks().find((t) => t.action === "address_pr_feedback").id, feedback.id);
    assert.deepEqual(prTasks().find((t) => t.action === "address_pr_feedback").input.commentRevisions, ["issue:9001@2026-10-19T02:00:00Z"]);
    f.comments.set(201, [f.comments.get(201)[1]]); await route();
    assert.ok(!prTasks().some((t) => t.action === "address_pr_feedback"));
    f.prs[0].state = "closed"; await route(); assert.equal(prTasks().length, 0);
    assert.equal(f.requests.length, 0, "Routing does not require agent inference");
  } else if (scenario === "routing_history") {
    f.addIssue(1); f.enqueue(1); const completed = await success();
    changeMain("src/app.ts", "export const value = 2;\n"); await route();
    const { eq } = await import("drizzle-orm");
    // Persisted history can outlive the Git object it describes (e.g. after GC).
    db.update(s.runs).set({ mainSha: "f".repeat(40) }).where(eq(s.runs.id, completed.id)).run();
    const isQueued = (id) => all(s.tasks).some((t) => t.itemId === id && t.status === "queued");
    f.addIssue(2); await route(); assert.ok(isQueued("issue-2"));
    const claim = tasks.claimTask(); assert.equal(claim.task.itemId, "issue-1");
    tasks.finishRun(claim.run.id, { status: "failed", error: new Error("Interrupted before inference") });
    f.addIssue(3); await route(); assert.ok(isQueued("issue-3")); assert.ok(!isQueued("issue-1"));
    for (const id of ["issue-2", "issue-3"]) tasks.cancelQueuedTasks(id, "Isolate manual review attempt");
    f.enqueue(1); f.reset(1, "incomplete"); const failed = await run();
    assert.equal(failed.error.code, "AGENT_INCOMPLETE");
    assert.equal(f.row(s.tasks, failed.taskId).input.triggerKey, undefined);
    const calls = f.requests.length; f.addIssue(4); await route();
    assert.ok(isQueued("issue-4")); assert.ok(!isQueued("issue-1")); assert.equal(f.requests.length, calls);
  } else if (scenario === "acceptance") {
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement"); f.modes.set(1, "no-change");
    const empty = await run(); assert.match(empty.error.message, /no changes/); assert.equal(f.prs.length, 0);
    let calls = f.requests.length; tasks.retryTask(empty.taskId, "validation");
    const stillEmpty = await run(); assert.match(stillEmpty.error.message, /no changes/); assert.equal(f.requests.length, calls);
    const implemented = await implement(2); const head = f.prs[0].head.sha;
    changeMain("src/app.ts", "export const value = 99;\n"); await route();
    const prItem = all(s.items).find((i) => i.kind === "pr");
    tasks.cancelQueuedTasks(prItem.id, "Exercise conflict postcondition directly", "review_pr");
    f.reset(202, "no-change"); const unresolved = await run();
    assert.match(unresolved.error.message, /still conflicts/); assert.equal(f.prs[0].head.sha, head);
    calls = f.requests.length; tasks.retryTask(unresolved.taskId, "validation");
    const stillConflicted = await run(); assert.match(stillConflicted.error.message, /still conflicts/); assert.equal(f.requests.length, calls);
    assert.ok(!f.row(s.workspaces, implemented.workspaceId).removedAt);
    tasks.enqueueTask({ itemId: prItem.id, action: "address_pr_feedback", reason: "Reply without code changes", input: {} });
    f.reset(202, "no-change"); const replied = await success();
    assert.equal(replied.publication.publishedCommitSha, head); assert.equal(f.prs.length, 1);
    assert.equal(f.comments.get(202).length, 1); assert.equal(replied.workspaceId, implemented.workspaceId);
  } else if (scenario === "panel") {
    const implemented = await implement(1); f.prs[0].labels.push({ name: "human-label" }); await route();
    const review = await success();
    assert.equal(review.reviewers.length, 2);
    assert.deepEqual(review.reviewers.map((r) => r.model), ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"]);
    assert.equal(new Set([...review.reviewers.map((r) => r.piSessionId), review.piSessionId]).size, 3);
    assert.ok(review.reviewers.every((r) => r.result?.outcome === "complete"));
    for (const model of ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"]) {
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("9.8.7"))), "Reviewer must read the prepared dependency in its own workspace");
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const value = 1;"))), "Reviewer must read the immutable base file, not the modified head");
    }
    for (const request of f.requests.filter((r) => r.context.action === "review_pr")) {
      assert.deepEqual(request.context.diffPaths, ["src/app.ts"]); assert.match(request.context.diffBaseSha, /^[a-f0-9]{40}$/);
    }
    assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === 201).length, 1);
    assert.match(f.comments.get(201)[0].body, /Consolidated/);
    assert.equal(review.result.grade, "B");
    // The prompt is a manifest: no patch bodies, with context in files outside the worktree and never committed.
    const prompts = (request) => request.request.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n");
    const toolText = (request, text) => request.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes(text));
    for (const request of f.requests) {
      assert.ok(!prompts(request).includes("diff --git"), "No model prompt may embed a patch"); assert.ok(!("diff" in request.context) && !("mainChanges" in request.context));
    }
    const panel = f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating);
    const consolidation = f.requests.filter((r) => r.consolidating);
    for (const model of ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"]) {
      const mine = panel.filter((r) => r.request.model === model).at(-1);
      assert.ok(toolText(mine, "src/app.ts | 2"), "diff_stat output reaches the model");
      assert.ok(toolText(mine, "node_modules/"), "show reads the immutable base file");
      assert.ok(toolText(mine, "diff --git") && toolText(mine, "truncated: bytes 0-20"), "capped diff pages");
      assert.ok(toolText(mine, "[]"), "The agent can read its context directory");
      assert.ok(toolText(mine, "must be repository-relative"), "option-like paths are rejected");
      for (const message of ["revision must be a hex commit SHA"]) assert.ok(toolText(mine, message), message);
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
    // Adopt a pre-upgrade review comment too, without deleting its historical run.
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
    assert.ok(failed.result.paths.includes("src/bulk.txt"), "Paths inspected through the git tool join review scope");
    assert.ok(second.some((r) => toolText(r, "src/bulk.txt")));
    for (const r of second) {
      assert.ok(!("changedPaths" in r.context.input) && r.context.input.changedPathCount >= 250);
      assert.ok(readFileSync(r.context.files.changedPaths, "utf8").split("\n").includes("src/many-249.txt"));
    }
    assert.equal(f.comments.get(201).filter((c) => c.user.login !== "human").length, 1);
    assert.equal(f.writes.filter((w) => w.type === "comment_update").length, 1);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
    const itemId = f.row(s.tasks, review.taskId).itemId;
    f.reset(201, "normal"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "Manual review", input: {} });
    f.faults.label.add(201); const older = await run(); assert.ok(older.error);
    f.reset(201, "grade-A"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "Newer manual review", input: {} });
    await success(); const writes = f.writes.length, inferences = f.requests.length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.writes.length, writes); assert.equal(f.requests.length, inferences);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
  } else if (scenario === "canonical") {
    await implement(1); await route(); f.faults.comment.add(201);
    const lost = await run(); assert.ok(lost.error); assert.equal(lost.stage, "publishing");
    const original = f.comments.get(201)[0];
    const feedback = { ...original, id: 9000, body: "Feedback quoting the review:\n```\n" + original.body + "\n```\n<!-- scrat-task:feedback -->" };
    f.comments.get(201).push(feedback);
    const calls = f.requests.length; tasks.retryTask(lost.taskId); const recovered = await success();
    assert.equal(f.requests.length, calls); assert.equal(recovered.publication.commentId, original.id);
    f.reset(201, "grade-A");
    tasks.enqueueTask({ itemId: f.row(s.tasks, lost.taskId).itemId, action: "review_pr", reason: "New assessment", input: {} });
    f.faults.comment.add(201); const lostUpdate = await run(); assert.ok(lostUpdate.error);
    assert.deepEqual(f.prs[0].labels, [], "A lost report-write response must not leave the old report's grade");
    const updateCalls = f.requests.length; tasks.retryTask(lostUpdate.taskId); const updated = await success();
    assert.equal(f.requests.length, updateCalls); assert.equal(updated.publication.commentId, original.id);
    assert.equal(f.comments.get(201).length, 2); assert.equal(f.comments.get(201)[1].body, feedback.body);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
  } else if (scenario === "deleted_review" || scenario === "unreceipted_review") {
    await implement(1); await route(); f.faults.label.add(201);
    const older = await run(); assert.ok(older.error); assert.ok(older.publication.commentId);
    const itemId = f.row(s.tasks, older.taskId).itemId;
    f.reset(201, "grade-A"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "New assessment", input: {} });
    if (scenario === "unreceipted_review") f.faults.comment.add(201);
    const newer = await run();
    if (scenario === "deleted_review") {
      assert.equal(newer.error, null);
      f.comments.set(201, []);
    } else {
      assert.ok(newer.error); assert.equal(newer.publication.commentId, undefined);
      assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    }
    const calls = f.requests.length, updates = f.writes.filter((w) => w.type === "comment_update").length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.requests.length, calls); assert.equal(f.comments.get(201).filter((c) => c.user.login !== "human").length, 1);
    assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    assert.equal(f.row(s.runs, newer.id).publication.commentId, f.comments.get(201)[0].id);
    const delivered = all(s.events).findLast((event) => scenario === "deleted_review"
      ? event.type === "github.comment_created" && event.data.commentId === f.comments.get(201)[0].id
      : event.type === "github.labels_added" && event.data.labels.includes("A · Strong"));
    assert.equal(delivered.runId, newer.id);
    if (scenario === "deleted_review") {
      f.comments.set(201, []); await route();
      assert.equal(f.requests.length, calls); assert.equal(f.comments.get(201).filter((c) => c.user.login !== "human").length, 1);
      assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    } else {
      assert.equal(f.writes.filter((w) => w.type === "comment_update").length, updates);
      tasks.retryTask(newer.taskId); await success(); assert.equal(f.requests.length, calls);
    }
  } else if (scenario === "stale_assessment") {
    changeMain("src/helper.ts", "export const helper = 1;\n");
    await implement(1); await route(); f.faults.label.add(201);
    const older = await run(); assert.ok(older.error);
    const itemId = f.row(s.tasks, older.taskId).itemId;
    f.reset(201, "helper-grade-A");
    // The newer assessment actually reads a broader scope than the older one.
    tasks.enqueueTask({ itemId, action: "review_pr", reason: "Broader fresh review", input: {} });
    const newer = await success();
    assert.ok(newer.result.paths.includes("src/helper.ts"));
    const report = f.comments.get(201)[0].body;
    changeMain("src/helper.ts", "export const helper = 2;\n");
    const calls = f.requests.length; await route();
    assert.deepEqual(f.prs[0].labels, [], "No historical grade may replace a stale newer grade");
    assert.equal(f.comments.get(201)[0].body, report);
    assert.ok(all(s.tasks).some((t) => t.itemId === itemId && t.action === "review_pr" && t.status === "queued"));
    tasks.cancelQueuedTasks(itemId, "Exercise an explicitly requested old publication retry", "review_pr");
    tasks.retryTask(older.taskId); const stale = await run();
    assert.match(stale.error.message, /fresh review/);
    assert.equal(f.requests.length, calls); assert.deepEqual(f.prs[0].labels, []);
    assert.equal(f.comments.get(201)[0].body, report);
  } else if (scenario === "assessment_order") {
    await implement(1); await route(); f.modes.set(201, "incomplete");
    const failed = await run(); assert.ok(failed.error); assert.notEqual(failed.stage, "publishing");
    const itemId = f.row(s.tasks, failed.taskId).itemId;
    f.reset(201, "normal"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "New task", input: {} });
    const middle = await success();
    // A misleading wall-clock timestamp must not decide inference precedence.
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ startedAt: "2099-01-01T00:00:00Z" }).where(eq(s.runs.id, middle.id)).run();
    f.reset(201, "grade-A"); tasks.retryTask(failed.taskId); const newest = await success();
    assert.equal(newest.result.grade, "A");
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
    assert.match(f.comments.get(201)[0].body, new RegExp(newest.taskId));
    const calls = f.requests.length; await route();
    assert.equal(f.requests.length, calls);
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
  } else if (scenario === "run_sequence") {
    const { eq } = await import("drizzle-orm");
    for (let n = 1; n <= 5; n++) f.addIssue(n);
    f.enqueue(1); f.enqueue(2, "implement"); // created first, claimed second
    const claims = [tasks.claimTask(), tasks.claimTask()];
    assert.deepEqual(claims.map((c) => c.task.action), ["implement", "review_issue"]);
    assert.deepEqual(claims.map((c) => c.run.sequence), [1, 2]);
    for (const c of claims) tasks.finishRun(c.run.id, { status: "completed" });
    for (let n = 3; n <= 5; n++) f.enqueue(n);
    const more = [tasks.claimTask(), tasks.claimTask(), tasks.claimTask()].map((c) => c.run);
    assert.deepEqual(more.map((r) => r.sequence), [3, 4, 5]);
    for (const r of more) tasks.finishRun(r.id, { status: "completed" });
    const [r1, r2, r3, r4, r5] = all(s.runs).sort((a, b) => a.sequence - b.sequence);
    assert.throws(() => db.$client.exec("UPDATE runs SET sequence = 1 WHERE sequence = 2"), /UNIQUE/);
    // Pre-upgrade shape: no sequence column, event ids that disagree with creation order, and runs without a run.started event.
    const swap = db.$client.prepare("UPDATE events SET id = ? WHERE id = ?");
    const eventId = (r) => db.$client.prepare("SELECT id FROM events WHERE run_id = ? AND type = 'run.started'").get(r.id).id;
    const [e1, e2] = [eventId(r1), eventId(r2)];
    swap.run(100000, e1); swap.run(e1, e2); swap.run(e2, 100000);
    db.$client.exec(`DELETE FROM events WHERE run_id IN ('${r4.id}', '${r5.id}') AND type = 'run.started'`);
    db.update(s.runs).set({ startedAt: "2021-01-01T00:00:00Z" }).where(eq(s.runs.id, r5.id)).run();
    db.update(s.runs).set({ startedAt: "2020-01-01T00:00:00Z" }).where(eq(s.runs.id, r4.id)).run();
    const create = db.$client.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get().sql;
    const legacySql = create.split("\n").filter((line) => !line.includes("`sequence`")).join("\n").replace("CREATE TABLE `runs`", "CREATE TABLE `legacy_runs`");
    const columns = db.$client.prepare("PRAGMA table_info(runs)").all().map((column) => column.name).filter((name) => name !== "sequence")
      .map((name) => '"' + name + '"').join(", ");
    db.$client.exec("PRAGMA foreign_keys = OFF");
    db.$client.exec(`BEGIN; ${legacySql}; INSERT INTO legacy_runs (${columns}) SELECT ${columns} FROM runs; DROP TABLE runs; ALTER TABLE legacy_runs RENAME TO runs; COMMIT;`);
    db.$client.exec("PRAGMA foreign_keys = ON");
    execFileSync(process.execPath, [resolve("app/node_modules/drizzle-kit/bin.cjs"), "push", "--dialect=sqlite", "--schema=./app/src/schema.ts", "--url=./data/scrat.sqlite"], { stdio: "pipe" });
    assert.deepEqual(db.$client.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(all(s.runs).length, 5); assert.ok(all(s.runs).every((r) => r.sequence === null));
    assert.ok(db.$client.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs_sequence_unique'").get());
    const { ensureRunSequences } = await f.app("startup.ts");
    assert.equal(ensureRunSequences(), 5);
    const order = () => all(s.runs).sort((a, b) => a.sequence - b.sequence).map((r) => r.id);
    // Eventless runs first (by startedAt), then event order (r2's event now precedes r1's).
    assert.deepEqual(order(), [r4.id, r5.id, r2.id, r1.id, r3.id]);
    assert.deepEqual(all(s.runs).map((r) => r.sequence).sort(), [1, 2, 3, 4, 5]);
    const before = all(s.runs);
    assert.equal(ensureRunSequences(), 0); assert.deepEqual(all(s.runs), before);
    db.update(s.runs).set({ sequence: null }).where(eq(s.runs.id, r4.id)).run();
    assert.equal(ensureRunSequences(), 1); assert.equal(f.row(s.runs, r4.id).sequence, 6);
    // Claims continue after the backfill.
    f.enqueue(1); assert.equal(tasks.claimTask().run.sequence, 7);
  } else if (scenario === "run_latest") {
    const { eq } = await import("drizzle-orm");
    // Issue-review baseline: the later claim is latest even when its startedAt is earlier.
    changeMain("src/helper.ts", "export const helper = 1;\n");
    f.addIssue(1); await route(); const first = await success(); assert.ok(first.result.paths.includes("src/app.ts"));
    f.enqueue(1); f.reset(1, "helper");
    const second = await success(); assert.ok(second.result.paths.includes("src/helper.ts")); assert.ok(second.sequence > first.sequence);
    db.update(s.runs).set({ startedAt: "2099-01-01T00:00:00Z" }).where(eq(s.runs.id, first.id)).run();
    db.update(s.runs).set({ startedAt: "1970-01-01T00:00:00Z" }).where(eq(s.runs.id, second.id)).run();
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.action === "review_issue" && t.status === "queued"), "The latest claimed review is the baseline");
    // Pi session continuation follows claim order in a workspace, not timestamps.
    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement"); const implemented = await success();
    const prItem = all(s.items).find((i) => i.kind === "pr");
    const feedback = async () => { tasks.enqueueTask({ itemId: prItem.id, action: "address_pr_feedback", reason: "Reply", input: {} }); f.reset(202, "no-change"); return success(); };
    const older = await feedback(); assert.equal(older.workspaceId, implemented.workspaceId);
    assert.equal(older.piSessionFile, implemented.piSessionFile);
    const copy = implemented.piSessionFile.replace(/\.jsonl$/, "-copy.jsonl");
    copyFileSync(implemented.piSessionFile, copy);
    db.update(s.runs).set({ piSessionFile: copy, startedAt: "1970-01-01T00:00:00Z" }).where(eq(s.runs.id, older.id)).run();
    db.update(s.runs).set({ startedAt: "2099-01-01T00:00:00Z" }).where(eq(s.runs.id, implemented.id)).run();
    const next = await feedback(); assert.equal(next.piSessionFile, copy);
  } else if (scenario === "scope_snapshots") {
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
  } else if (scenario === "grade_race") {
    await implement(1); await route(); const reviewed = await success();
    tasks.enqueueTask({ itemId: f.row(s.tasks, reviewed.taskId).itemId, action: "review_pr", reason: "Fresh review", input: {} });
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
  } else if (scenario === "grade_failure") {
    await implement(1); await implement(2); await route(); await success(); await success();
    changeMain("src/app.ts", "export const value = 99;\n");
    f.faults.label.add(201); await route();
    for (const number of [201, 202]) assert.ok(all(s.tasks).some((t) => t.status === "queued" && f.row(s.items, t.itemId).payload.number === number));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    await route(); assert.deepEqual(f.prs[0].labels, []);
  } else if (scenario === "absent_labels") {
    f.addIssue(1); const { reconcileLabels } = await f.app("labels.ts");
    const { GitHubRepository } = await f.app("github.ts");
    const request = () => reconcileLabels(new GitHubRepository("fixture/project"), 1, { current: ["scrat"], desired: [], managed: ["scrat"] });
    await request();
    assert.equal(all(s.events).filter((e) => e.type === "github.label_removed").length, 0);
    f.issues.get(1).labels = [{ name: "scrat" }];
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => options.method === "DELETE"
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }) : fetch(input, options);
    try { await assert.rejects(request(), (error) => error.status === 404); }
    finally { globalThis.fetch = fetch; }
    f.issues.delete(1);
    await assert.rejects(request(), (error) => error.status === 404);
  } else if (scenario === "footer") {
    await implement(1); f.modes.set(201, "quoted-grade"); await route();
    const reviewed = await success();
    assert.equal(reviewed.result.grade, "A");
    assert.match(f.comments.get(201)[0].body, /```\nSCRAT_GRADE: F\nSCRAT_READY\n```/);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.reset(201, "quoted-only");
    tasks.enqueueTask({ itemId: f.row(s.tasks, reviewed.taskId).itemId, action: "review_pr", reason: "Review again", input: {} });
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.addIssue(2); f.modes.set(2, "quoted-only"); f.enqueue(2);
    const issue = await success(); assert.equal(issue.result.ready, false);
    assert.deepEqual(f.issues.get(2).labels, []);
  } else if (scenario === "reviewer_failure") {
    await implement(2); await route(); f.modes.set(202, "reviewer-failure");
    const r = await run(); assert.ok(r.error); assert.ok(r.reviewers.some((r) => r.error));
    assert.equal(f.requests.filter((r) => r.consolidating).length, 0);
    assert.equal(f.writes.filter((w) => w.type === "comment").length, 0);
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
    f.reset(202, "missing-grade"); tasks.retryTask(r.taskId);
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.equal(f.writes.filter((w) => w.type === "comment").length, 0);
  } else if (scenario === "incomplete") {
    for (const [i, mode] of ["incomplete", "needs_decision", "no-status", "bare-status"].entries()) {
      f.addIssue(i + 1); f.enqueue(i + 1, "implement"); f.modes.set(i + 1, mode);
      const r = await run(); assert.ok(r.error); assert.equal(f.row(s.tasks, r.taskId).status, "failed");
      assert.ok(existsSync(f.row(s.workspaces, r.workspaceId).path + "/src/app.ts"));
    }
    assert.equal(f.prs.length, 0); assert.equal(f.writes.length, 0);
  } else if (scenario === "verification") {
    const r = await implement(1);
    assert.equal(r.verification.headSha, r.publication.publishedCommitSha);
    assert.match(r.verification.commands[0].stdout, /checked actual source/);
    assert.equal(git(resolve("remote.git"), "rev-parse", f.prs[0].head.ref), r.verification.headSha);
    changeMain("fail-validation", "fail\n");
    f.addIssue(2); f.enqueue(2, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(f.prs.length, 1); assert.equal(failed.verification, null);
    assert.equal(failed.error.exitCode, 7);
    assert.match(failed.error.stdout, /validation detail \[redacted\]/);
    assert.match(failed.error.stderr, /Verification failed/);
    assert.ok(!JSON.stringify(failed.error).includes("ghs_fixture_sensitive"));
  } else if (scenario === "validation_mutation") {
    f.addIssue(1); f.enqueue(1, "implement"); const r = await run();
    assert.match(r.error.message, /Validation changed/); assert.equal(f.prs.length, 0);
  } else if (scenario === "validation_resume") {
    f.addIssue(1); f.enqueue(1, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(failed.stage, "validating");
    const calls = f.requests.length;
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 2);
    // Exercise the public CLI, including its persisted queue mode across processes.
    execFileSync(process.execPath, [resolve("app/src/retry.ts"), failed.taskId, "--validation-only"], { stdio: "pipe" });
    f.faults.pr.add(1); const publishing = await run();
    assert.equal(f.requests.length, calls, "Validation resume must not invoke Pi");
    assert.equal(publishing.stage, "publishing"); assert.ok(publishing.error);
    assert.equal(publishing.inferenceFromRunId, failed.id); assert.equal(publishing.piSessionId, failed.piSessionId);
    assert.equal(publishing.verification.headSha, publishing.publication.commitSha);
    const receipts = readFileSync("database-receipts.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(receipts.map((receipt) => receipt.rows), [1, 0]); assert.notEqual(receipts[0].id, receipts[1].id);
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 3, "Resume retains post-agent preparation exactly once");
    tasks.retryTask(publishing.taskId); const published = await success();
    assert.equal(f.requests.length, calls); assert.equal(f.prs.length, 1);
    assert.equal(published.inferenceFromRunId, publishing.id); assert.deepEqual(published.verification, publishing.verification);
    assert.equal(readFileSync("database-receipts.jsonl", "utf8").trim().split("\n").length, 2);
    for (const attempt of [failed, publishing, published]) assert.equal(execFileSync("docker", ["ps", "-a", "--filter", `name=^/scrat-v2-db-${attempt.id}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim(), "");
  } else if (scenario === "validation_guards") {
    const { eq } = await import("drizzle-orm");
    const changes = [
      (w) => writeFileSync(w.path + "/src/app.ts", "export const changed = true;\n"),
      (w) => writeFileSync(w.path + "/unexpected.ts", "untracked source\n"),
      (w) => git(w.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Changed HEAD"),
      (_w, n) => { f.issues.get(n).body = "Different requirements"; },
      () => changeMain("notes.md", "Base changed\n"),
      (_w, n) => db.update(s.items).set({ workspaceId: null }).where(eq(s.items.id, "issue-" + n)).run(),
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
    f.addIssue(99); f.enqueue(99, "implement"); f.modes.set(99, "incomplete"); const partial = await run();
    assert.equal(partial.result.outcome, "incomplete");
    assert.throws(() => tasks.retryTask(partial.taskId, "validation"), /complete agent checkpoint/);
    f.addIssue(100); f.enqueue(100, "implement"); const changedInput = await run();
    db.update(s.tasks).set({ input: { requirements: "new" } }).where(eq(s.tasks.id, changedInput.taskId)).run();
    assert.throws(() => tasks.retryTask(changedInput.taskId, "validation"), /unchanged task input/);
    f.addIssue(101); f.enqueue(101, "implement"); const replaced = await run();
    tasks.retryTask(replaced.taskId, "validation");
    f.enqueue(101, "implement", { requirements: "replacement" });
    assert.equal(f.row(s.tasks, replaced.taskId).retryMode, "repair");
    f.reset(99, "normal"); unlinkSync("block-validation"); const calls = f.requests.length;
    tasks.retryTask(partial.taskId); const repaired = await success();
    assert.equal(repaired.taskId, partial.taskId);
    assert.ok(f.requests.length > calls); assert.equal(repaired.inferenceFromRunId, null);
    assert.equal(repaired.piSessionId, partial.piSessionId, "Normal retry repairs in the existing session");
    const replacementCalls = f.requests.length; f.reset(101, "normal"); const replacement = await success();
    assert.equal(replacement.taskId, replaced.taskId); assert.ok(f.requests.length > replacementCalls);
    assert.equal(replacement.inferenceFromRunId, null);
  } else if (scenario === "resume_migration") {
    f.addIssue(1); f.enqueue(1, "implement"); const first = await run(); assert.equal(first.error.exitCode, 7);
    f.reset(1, "normal"); tasks.retryTask(first.taskId); const failed = await run();
    assert.equal(failed.retryOfRunId, first.id);
    const history = all(s.events);
    // Rebuild only this disposable fixture's table: SQLite cannot DROP a
    // column while its table-level foreign-key constraint still references it.
    const removed = ["agent_checkpoint", "inference_from_run_id"];
    const create = db.$client.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get().sql;
    const legacySql = create.split("\n").filter((line) => !removed.some((name) => line.includes("`" + name + "`"))).join("\n")
      .replace("CREATE TABLE `runs`", "CREATE TABLE `legacy_runs`");
    const columns = db.$client.prepare("PRAGMA table_info(runs)").all().map((column) => column.name).filter((name) => !removed.includes(name))
      .map((name) => '"' + name + '"').join(", ");
    db.$client.exec("PRAGMA foreign_keys = OFF");
    db.$client.exec(`BEGIN; ALTER TABLE tasks DROP COLUMN retry_mode; ${legacySql}; INSERT INTO legacy_runs (${columns}) SELECT ${columns} FROM runs; DROP TABLE runs; ALTER TABLE legacy_runs RENAME TO runs; COMMIT;`);
    db.$client.exec("PRAGMA foreign_keys = ON");
    execFileSync(process.execPath, [resolve("app/node_modules/drizzle-kit/bin.cjs"), "push", "--dialect=sqlite", "--schema=./app/src/schema.ts", "--url=./data/scrat.sqlite"], { stdio: "pipe" });
    assert.deepEqual(db.$client.prepare("PRAGMA foreign_key_check").all(), []);
    const legacy = f.row(s.runs, failed.id);
    assert.deepEqual(legacy.result, failed.result); assert.deepEqual(legacy.error, failed.error); assert.equal(legacy.piSessionId, failed.piSessionId);
    assert.equal(legacy.agentCheckpoint, null); assert.equal(legacy.inferenceFromRunId, null);
    assert.equal(legacy.retryOfRunId, first.id); assert.deepEqual(f.row(s.runs, first.id).result, first.result);
    assert.equal(f.row(s.tasks, failed.taskId).retryMode, "repair"); assert.deepEqual(all(s.events), history);
    assert.throws(() => tasks.retryTask(failed.taskId, "validation"), /complete agent checkpoint/);
    unlinkSync("block-validation"); f.reset(1, "normal"); const calls = f.requests.length;
    tasks.retryTask(failed.taskId); await success(); assert.ok(f.requests.length > calls);
  } else if (scenario === "retry") {
    for (const [n, fault] of [[1, "label"], [2, "comment"]]) {
      f.addIssue(n, ["human-label"]); f.modes.set(n, "ready"); f.enqueue(n); f.faults[fault].add(n);
      const failed = await run(); assert.ok(failed.error); const calls = f.requests.length;
      tasks.retryTask(failed.taskId); const completed = await success();
      assert.equal(completed.retryOfRunId, failed.id); assert.equal(f.requests.length, calls);
      assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === n).length, 1);
      assert.deepEqual(f.issues.get(n).labels.map((label) => label.name).sort(), ["human-label", "scrat"]);
    }
    f.modes.set(1, "normal"); f.enqueue(1); await success();
    assert.deepEqual(f.issues.get(1).labels.map((label) => label.name), ["human-label"]);
  } else if (scenario === "ambiguous_pr") {
    f.addIssue(1); f.enqueue(1, "implement"); f.faults.pr.add(1);
    const failed = await run(); assert.ok(failed.error); assert.equal(f.prs.length, 1); const calls = f.requests.length;
    tasks.retryTask(failed.taskId); const completed = await success();
    assert.equal(completed.publication.pullRequestNumber, 201); assert.equal(f.prs.length, 1); assert.equal(f.requests.length, calls);
  } else if (scenario === "freshness") {
    f.addIssue(1); await route(); f.modes.set(1, "ready");
    f.onModel = () => { f.issues.get(1).body = "New requirements"; };
    const r = await run(); assert.match(r.error.message, /context changed/); assert.equal(f.writes.length, 0);
    f.onModel = undefined; await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"));
    f.addIssue(2); f.enqueue(2, "implement"); f.onModel = () => { f.issues.get(2).body = "Changed implementation requirements"; };
    const stale = await run(); assert.match(stale.error.message, /context changed/); assert.equal(f.prs.length, 0);
  } else if (scenario === "relevance") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); const r = await success();
    assert.ok(r.result.paths.includes("src/app.ts")); assert.ok(!r.result.paths.includes("."));
    changeMain("notes.md", "new docs\n"); await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "2.0.0" } }));
    changeMain("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@2.0.0:\n    resolution: {integrity: new}\n");
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"), "Unrelated dev dependencies must not trigger review");
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "2.0.0", unrelated: "2.0.0" } }));
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"), "Inspected dependency changes must trigger review");
  } else if (scenario === "freshness_policy") {
    const { freshness, savedEvaluation } = await f.app("freshness.ts");
    const { fetchRepository } = await f.app("git.ts");
    const fetchMain = () => fetchRepository(f.config.github.repositoryPath, "https://github.com/fixture/project.git", "main");
    f.addIssue(1); f.modes.set(1, "grep"); await route(); const saved = savedEvaluation(await success());
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
    assert.equal((await freshness(unknown, now, "relevant-paths", { unknownBase: "current" })).kind, "current");
    changeMain("notes.md", "new docs\n"); const docsSha = await fetchMain(); assert.notEqual(docsSha, saved.mainSha);
    assert.deepEqual(await freshness(saved, { ...now, mainSha: docsSha }, "relevant-paths"), { kind: "current", baseMoved: true });
    assert.deepEqual(await freshness(saved, { ...now, mainSha: docsSha }, "exact"), { kind: "stale", reason: "base", changedPaths: [] });
    changeMain("src/app.ts", "export const changed = true;\n"); const codeSha = await fetchMain();
    const relevant = await freshness(saved, { ...now, mainSha: codeSha }, "relevant-paths");
    assert.equal(relevant.kind, "stale"); assert.equal(relevant.reason, "base"); assert.ok(relevant.changedPaths.includes("src/app.ts"));
  } else if (scenario === "lockfile_scope") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); await success();
    let lock = readFileSync("seed/pnpm-lock.yaml", "utf8");
    for (const update of [
      (text) => text.replace("integrity: old", "integrity: changed").replace("unrelated@1.0.0", "unrelated@2.0.0"),
      (text) => text.replace("npm:string-width@4.2.2", "npm:string-width@4.2.3").replace("unrelated@2.0.0", "unrelated@3.0.0"),
      (text) => text.replace("nested: 1.0.0", "nested: 2.0.0").replace("unrelated@3.0.0", "unrelated@4.0.0"),
      (text) => text.replace("version: 1.0.0}", "version: 2.0.0}").replace("unrelated@4.0.0", "unrelated@5.0.0"),
      (text) => text + "unknownSetting: changed\n",
    ]) {
      lock = update(lock); changeMain("pnpm-lock.yaml", lock); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"), lock);
      f.reset(1, "grep"); await success();
    }
    changeMain("pnpm-lock.yaml", lock.replace("unrelated@5.0.0", "unrelated@6.0.0")); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
  } else if (scenario === "importer_scope") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); await success();
    const lock = JSON.parse(readFileSync("seed/pnpm-lock.yaml", "utf8"));
    const bump = (name, version) => {
      const entry = lock.importers["."].devDependencies[name];
      const old = name + "@" + entry.version, next = name + "@" + version;
      delete lock.packages[old]; delete lock.snapshots[old];
      lock.packages[next] = { resolution: { integrity: version } }; lock.snapshots[next] = {};
      entry.specifier = version; entry.version = version;
    };
    bump("unrelated", "2.0.0");
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "2.0.0" } }));
    changeMain("pnpm-lock.yaml", JSON.stringify(lock)); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    for (const update of [
      () => bump("wrangler", "2.0.0"),
      () => { lock.importers["."].devDependencies.alternate = { specifier: "npm:wrangler@2.0.0", version: "wrangler@2.0.0" }; },
      () => { lock.importers["."].devDependencies.unrelated = { specifier: "workspace:*", version: "link:../unrelated" }; },
      () => { lock.importers["."].injectedSetting = true; },
      () => { lock.importers["."].devDependencies.unrelated = "3.0.0"; },
      () => { lock.importers["packages/new"] = {}; },
    ]) {
      update(); changeMain("pnpm-lock.yaml", JSON.stringify(lock)); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
      f.reset(1, "grep"); await success();
    }
  } else if (scenario === "unicode_scope") {
    f.addIssue(1); await route(); await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const special = 1;"))));
    changeMain("src/a b.ts", "export const special = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal");
    let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/a b.ts", "export const special = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } else if (scenario === "unicode_nfd") {
    f.addIssue(1); await route(); const reviewed = await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const unicode = 1;"))));
    assert.ok(reviewed.result.paths.includes("src/caf\u00e9.ts"));
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ result: { ...reviewed.result, paths: ["src/cafe\u0301.ts"] } }).where(eq(s.runs.id, reviewed.id)).run();
    changeMain("src/caf\u00e9.ts", "export const unicode = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal"); let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/caf\u00e9.ts", "export const unicode = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } else if (scenario === "legacy_scope") {
    f.addIssue(1); await route(); let reviewed = await success();
    const { eq } = await import("drizzle-orm");
    for (const paths of [[".", "src/app.ts"], ["."], ["src"]]) {
      db.update(s.runs).set({ result: { ...reviewed.result, paths } }).where(eq(s.runs.id, reviewed.id)).run();
      changeMain(paths[0] === "src" ? "src/helper.ts" : "notes.md", JSON.stringify(paths)); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
      reviewed = await success();
    }
  } else if (scenario === "review_scope") {
    f.addIssue(1); f.modes.set(1, "at"); await route();
    const reviewed = await success(); assert.ok(reviewed.result.paths.includes("src/app.ts"));
    changeMain("src/app.ts", "export const value = 9;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 1;\n");
    await implement(2); await route(); f.modes.set(202, "helper");
    let changed = false;
    f.onModel = (context) => {
      if (!changed && context.item.number === 202) { changed = true; changeMain("src/app.ts", "export const value = 99;\n"); }
    };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
    assert.ok(stale.result.paths.includes("src/app.ts")); assert.ok(stale.result.paths.includes("src/helper.ts"));
    assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === 202).length, 0);
  } else if (scenario === "merge") {
    const original = await implement(1); changeMain("src/app.ts", "export const value = 200;\n");
    await route(); f.modes.set(201, "merge-failure");
    // Conflict repair and reviews share the item; explicitly take repair first here.
    const { eq } = await import("drizzle-orm");
    for (const t of all(s.tasks).filter((t) => t.action === "review_pr")) db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, t.id)).run();
    const failed = await run(); assert.ok(failed.error);
    const w = f.row(s.workspaces, original.workspaceId);
    assert.ok(await (await f.app("git.ts")).hasPendingMerge(w.path));
    f.reset(201, "normal"); tasks.retryTask(failed.taskId); const recovered = await success();
    assert.equal(f.requests.findLast((r) => r.context.action === "resolve_conflicts").context.workspace.mergeInProgress, true);
    assert.equal(git(w.path, "show", "-s", "--format=%P").split(" ").length, 2);
    assert.equal(recovered.workspaceId, original.workspaceId);
  } else if (scenario === "reopen") {
    const original = await implement(1); await route();
    f.prs[0].state = "closed"; await route(); assert.ok(f.row(s.workspaces, original.workspaceId).removedAt);
    f.prs[0].state = "open"; await (await f.app("github-sync.ts")).syncGitHub(undefined, false); await route();
    const pr = all(s.items).find((i) => i.kind === "pr"); assert.equal(pr.workspaceId, null);
    assert.ok(all(s.tasks).some((t) => t.itemId === pr.id && t.status === "queued"));
  } else if (scenario === "existing_pr") {
    await implement(1); f.addIssue(2, ["scrat"]); f.prs[0].body += "\nFixes #2";
    f.enqueue(2, "implement"); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-2" && t.status === "queued"));
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
  } else if (scenario === "rejection") {
    const { eq } = await import("drizzle-orm");
    const rejections = () => all(s.events).filter((e) => e.type === "task.rejected");
    for (let n = 1; n <= 4; n++) f.addIssue(n);
    db.$client.prepare("INSERT INTO tasks (id, item_id, action, priority, reason, input, created_at) VALUES ('bogus', 'issue-1', 'ship_it', 1000, 'Integration', '{}', '2026-01-01')").run();
    f.enqueue(2);
    const claim = tasks.claimTask();
    assert.equal(claim.task.itemId, "issue-2");
    assert.equal(f.row(s.tasks, "bogus").status, "failed");
    assert.equal(rejections().length, 1);
    assert.deepEqual({ ...rejections()[0].data, taskId: rejections()[0].taskId }, { action: "ship_it", reason: "Unknown action: ship_it", taskId: "bogus" });
    assert.equal(tasks.claimTask(), undefined);
    tasks.retryTask("bogus"); assert.equal(tasks.claimTask(), undefined);
    assert.equal(rejections().length, 2); assert.equal(f.row(s.tasks, "bogus").status, "failed");
    tasks.finishRun(claim.run.id, { status: "completed" });

    f.enqueue(3); const damaged = tasks.claimTask();
    tasks.finishRun(damaged.run.id, { status: "failed", error: new Error("Interrupted") });
    db.update(s.runs).set({ sequence: null }).where(eq(s.runs.id, damaged.run.id)).run();
    assert.throws(() => tasks.retryTask(damaged.task.id, "validation"), /Validation-only retry requires/);
    assert.throws(() => tasks.retryTask("bogus", "validation"), /Validation-only retry requires/);
    tasks.retryTask(damaged.task.id); f.enqueue(4);
    assert.equal(tasks.claimTask().task.itemId, "issue-4");
    assert.equal(f.row(s.tasks, damaged.task.id).status, "failed");
    assert.match(rejections().at(-1).data.reason, /Missing run sequence/);
    assert.equal(rejections().at(-1).taskId, damaged.task.id);
    assert.equal(rejections().length, 3);

    const { config: live } = await f.app("config.ts"); live.actions.review_pr.thinkingLevel = "turbo";
    f.addIssue(5); f.addIssue(6); f.enqueue(5, "review_pr"); f.enqueue(6);
    assert.equal(tasks.claimTask().task.itemId, "issue-6");
    assert.equal(f.row(s.tasks, all(s.tasks).find((t) => t.itemId === "issue-5").id).status, "failed");
    assert.match(rejections().at(-1).data.reason, /Invalid thinking level for review_pr: turbo/);
    live.actions.review_pr.thinkingLevel = "high";

    const { validateStaticConfig } = await f.app("startup.ts");
    await validateStaticConfig(f.config);
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.implement.thinkingLevel = "turbo"; })), /implement: invalid thinking level turbo/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_pr.reviewers[1].thinkingLevel = "turbo"; })), /review_pr reviewer 2: invalid thinking level/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_issue.model = "missing-model"; })), /review_issue: no Pi model fixture\/missing-model/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_pr.reviewers[0].provider = "nowhere"; })), /review_pr reviewer 1: no Pi model nowhere/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.resolve_conflicts.skill = "skills/missing/SKILL.md"; })), /resolve_conflicts: skill file not found/);
  } else if (scenario === "single_repository") {
    const { eq } = await import("drizzle-orm");
    const { syncGitHub } = await f.app("github-sync.ts");
    const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = (...args) => { calls.push(args[0]); return realFetch(...args); };
    for (const other of ["other/repo", "Fixture/Project2"]) {
      await assert.rejects(syncGitHub(other), /serves only fixture\/project/);
      await assert.rejects(syncGitHub(other, false), /serves only fixture\/project/);
    }
    assert.equal(calls.length, 0); assert.equal(all(s.githubSnapshots).length, 0); assert.equal(all(s.items).length, 0);
    await syncGitHub(undefined, false); assert.ok(calls.length > 0);

    f.addIssue(1); f.addIssue(2);
    db.update(s.items).set({ payload: { ...f.issues.get(1), html_url: "https://github.com/other/repo/issues/1" } }).where(eq(s.items.id, "issue-1")).run();
    f.enqueue(1, "review_issue"); f.enqueue(2, "review_issue");
    db.update(s.tasks).set({ priority: 1000 }).where(eq(s.tasks.itemId, "issue-1")).run();
    assert.equal(tasks.claimTask().task.itemId, "issue-2");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].data.reason, /Item belongs to other\/repo, not fixture\/project/);
    assert.equal(f.row(s.tasks, rejected[0].taskId).status, "failed");
    f.addIssue(3); f.addIssue(4); f.enqueue(3); f.enqueue(4);
    db.update(s.items).set({ payload: { ...f.issues.get(3), html_url: "not a url" } }).where(eq(s.items.id, "issue-3")).run();
    db.update(s.items).set({ payload: { ...f.issues.get(4), html_url: "https://example.com/fixture/project/issues/4" } }).where(eq(s.items.id, "issue-4")).run();
    assert.equal(tasks.claimTask(), undefined);
    const bad = all(s.events).filter((e) => e.type === "task.rejected").slice(1);
    assert.equal(bad.length, 2);
    for (const e of bad) assert.match(e.data.reason, /Unparseable item URL/);

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
      writeFileSync("seed/src/app.ts", `export const value = ${index + 2};\n`); git(resolve("seed"), "add", "."); commit(resolve("seed"), "Advance " + index);
      git(resolve("seed"), "push", resolve("remote.git"), "main");
      const before = git(checkout, "rev-parse", "refs/remotes/origin/main");
      await assert.rejects(fetchRepository(checkout, remote, "main"), /has origin .* not https:\/\/github\.com\/fixture\/project\.git/);
      assert.equal(git(checkout, "rev-parse", "refs/remotes/origin/main"), before);
    }
  } else if (scenario === "recovery") {
    f.addIssue(1); f.enqueue(1); const claim = tasks.claimTask();
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ stage: "publishing", result: { text: "Saved", ready: false, paths: [], outcome: "complete" }, publication: { status: "pending", commentId: 123 } }).where(eq(s.runs.id, claim.run.id)).run();
    execFileSync(process.execPath, [resolve("app/src/recover.ts"), claim.run.id], { stdio: "pipe" });
    const r = f.row(s.runs, claim.run.id); assert.equal(r.error.code, "RUN_INTERRUPTED"); assert.equal(r.result.text, "Saved"); assert.equal(r.publication.commentId, 123);
    tasks.retryTask(r.taskId); assert.ok(tasks.claimTask());
  } else if (scenario === "cleanup") {
    f.addIssue(1); f.enqueue(1); f.faults.cleanup.add(1); const r = await success();
    assert.equal(f.row(s.tasks, r.taskId).status, "completed"); const w = f.row(s.workspaces, r.workspaceId);
    assert.equal(w.removedAt, null); assert.equal(readFileSync(w.path + "/keep.txt", "utf8"), "preserve\n");
    unlinkSync(w.path + "/keep.txt"); execFileSync(process.execPath, [resolve("app/src/cleanup.ts")], { stdio: "pipe" });
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
  } else if (scenario === "identity") {
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
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-2" && t.status === "queued"));
  } else if (scenario === "feedback") {
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
  } else if (scenario === "commit_hook") {
    f.addIssue(1); f.enqueue(1, "implement");
    f.onModel = (_context, step) => {
      if (step) return;
      const hook = resolve(f.config.github.repositoryPath, ".git/hooks/pre-commit");
      copyFileSync(hook + ".sample", hook);
      writeFileSync(hook, '#!/bin/sh\nprintf "export const value = 909;\\n" > src/app.ts\ngit add src/app.ts\n');
    };
    const r = await run(); assert.match(r.error.message, /Committed tree differs/);
    assert.equal(r.verification, null); assert.equal(f.prs.length, 0);
  } else if (scenario === "isolation") {
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    f.addIssue(1); f.reset(1, "outside"); f.enqueue(1); await success();
    const transcript = f.requests.filter(({ context }) => context.item.number === 1).at(-1).request.messages;
    assert.equal(transcript.filter((message) => message.role === "tool" && JSON.stringify(message.content).includes("outside the workspace")).length, 4);
    assert.ok(!JSON.stringify(f.requests.map(({ request }) => request.messages)).includes("outside-secret-content"));
    f.addIssue(2); f.reset(2, "leak-report"); f.enqueue(2);
    const report = await run(); assert.equal(report.error.code, "SECRET_IN_OUTPUT");
    assert.ok(!f.writes.some((write) => write.number === 2));
    f.onModel = (context, step) => {
      if (step || context.action !== "implement" || context.item.number !== 3) return;
      for (const name of ["pre-commit", "pre-push"]) {
        const hook = resolve(f.config.github.repositoryPath, ".git/hooks", name);
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
  } else if (scenario === "wakeup") {
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
    setTimeout(() => controller.abort(), 20);
    const aborted = await timed(waitForWork(workGeneration(), 5_000, controller.signal));
    assert.ok(aborted < 1000, `Abort should release the waiter, took ${aborted}ms`);
    const notified = await timed(((since) => { const waiting = waitForWork(since, 5_000); signalWork(); return waiting; })(workGeneration()));
    assert.ok(notified < 1000, `Explicit signal should wake the waiter, took ${notified}ms`);
  } else if (scenario === "sync_cost") {
    await implement(1); await implement(2); f.addIssue(10); f.addIssue(11);
    const { GitHubRepository } = await f.app("github.ts");
    const reads = (since) => f.calls.slice(since).filter((call) => call.method === "GET" && !call.path.endsWith("/access_tokens"));
    const count = (since, pattern) => reads(since).filter((call) => pattern.test(call.path)).length;
    let since = f.calls.length;
    await route();
    // One observation per PR (four concurrent reads, none repeated by reconciliation); issues reuse list metadata.
    for (const number of [201, 202]) {
      assert.equal(count(since, new RegExp(`/pulls/${number}$`)), 1);
      assert.equal(count(since, new RegExp(`/issues/${number}/comments`)), 1);
      assert.equal(count(since, new RegExp(`/pulls/${number}/(comments|reviews)`)), 2);
    }
    for (const number of [10, 11]) {
      assert.equal(count(since, new RegExp(`/issues/${number}$`)), 0);
      assert.equal(count(since, new RegExp(`/issues/${number}/comments`)), 1);
    }
    // Nothing changed: every read is a conditional request answered 304.
    since = f.calls.length; await route();
    assert.ok(reads(since).length >= 12);
    assert.deepEqual(reads(since).filter((call) => call.status !== 304), []);
    const remaining = f.rate.remaining; await route(); assert.equal(f.rate.remaining, remaining, "304s do not consume the rate limit");
    // A comment added between syncs is seen; unchanged resources stay cached.
    f.comments.set(202, [{ id: 900, body: "Please rename this", user: { login: "human" }, updated_at: "2026-10-19T02:00:00Z", html_url: "https://github.com/fixture/project/pull/202#c900" }]);
    since = f.calls.length; await route();
    assert.equal(reads(since).find((call) => call.path.includes("/issues/202/comments")).status, 200);
    assert.equal(reads(since).find((call) => call.path.includes("/issues/201/comments")).status, 304);
    assert.ok(all(s.tasks).some((task) => task.action === "address_pr_feedback" && f.row(s.items, task.itemId).payload.number === 202));
    // A full page is never served from cache: the 101st comment must appear even though page one is byte-identical.
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
    // Low rate-limit headroom defers item reads but still lists, and recovers when the window has room.
    f.rate.remaining = 100; since = f.calls.length; await route();
    assert.equal(count(since, /\/comments|\/reviews|\/pulls\/\d+$/), 0);
    assert.ok(count(since, /\/issues\?/) > 0);
    f.rate.remaining = 5000; since = f.calls.length; await route();
    assert.ok(count(since, /\/issues\/10\/comments/) > 0);
    // One failing read of a PR's four concurrent reads fails the sync, leaves no read running, and the next sync recovers.
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
        f.comments.set(201, [{ id: 901, body: "Changed so reads are not 304", user: { login: "human" }, updated_at: "2026-10-19T03:00:00Z", html_url: "https://github.com/fixture/project/pull/201#c901" }]);
        await assert.rejects(route(), (error) => error.status === 404);
        assert.equal(active, 0, "A failed PR read must wait for its sibling reads");
        failing = false; await route();
      } finally { globalThis.fetch = original; }
    }
    // A worker publishing while sync holds a PR's observation cannot be missed or duplicated.
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
      // Wait until the worker has its result and is heading for publication, which must queue behind sync's lock.
      while (!all(s.runs).some((r) => r.result && !r.finishedAt)) await new Promise((done) => setTimeout(done, 10));
      for (let turn = 0; turn < 50; turn++) await new Promise((done) => setImmediate(done));
      release();
      const [, published] = await Promise.all([syncing, working]);
      assert.equal(published.error, null, JSON.stringify(published.error));
      assert.equal(f.writes.filter((write) => write.type === "comment" && write.number === 201).length, 1);
      assert.equal(f.comments.get(201).filter((c) => c.user.login !== "human").length, 1);
      await route(); assert.equal(f.comments.get(201).filter((c) => c.user.login !== "human").length, 1);
    } finally { release(); globalThis.fetch = fetch; }
  } else if (scenario === "database") {
    const original = process.env.DATABASE_URL; f.addIssue(1); f.addIssue(2); f.enqueue(1, "implement"); f.enqueue(2, "implement");
    const runs = await Promise.all([f.runNextTask(), f.runNextTask()]);
    for (const r of runs) assert.equal(r.error, null, JSON.stringify(r.error));
    const urls = new Set(f.requests.map((r) => r.context.database.url)); assert.equal(urls.size, 2);
    assert.equal(process.env.DATABASE_URL, original);
    for (const r of runs) assert.equal(execFileSync("docker", ["ps", "-a", "--filter", `name=^/scrat-v2-db-${r.id}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim(), "");
  } else if (scenario === "operations") {
    const { withOperation, withOperationSync } = await f.app("logging.ts"), { sql } = await import("drizzle-orm");
    const { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return write(fd, data, ...rest); };
    try {
      assert.equal(await withOperation("test.ok", { a: 1 }, async (op) => { op.stage("one"); op.complete({ done: true }); return 42; }), 42);
      const boom = new Error("boom");
      await assert.rejects(withOperation("test.fail", { a: 2 }, async (op) => { op.stage("one"); op.stage("two"); op.failure({ extra: 7 }); throw boom; }), (error) => error === boom);
      await assert.rejects(withOperation("test.plain", {}, async () => { throw boom; }), (error) => error === boom);
      db.run(sql`create table op_check (n integer)`);
      assert.equal(withOperationSync("test.sync", {}, (op) => db.transaction((transaction) => {
        transaction.run(sql`insert into op_check values (1)`); op.complete(); return "sync";
      })), "sync");
      assert.throws(() => withOperationSync("test.sync_fail", {}, (op) => { op.stage("tx"); throw boom; }), (error) => error === boom);
    } finally { fs.writeSync = write; }
    const events = (operation) => lines.filter((line) => line.operation === operation).map((line) => line.event);
    assert.deepEqual(events("test.ok"), ["operation.started", "operation.completed"]);
    assert.equal(lines.find((line) => line.operation === "test.ok" && line.event === "operation.completed").done, true);
    assert.deepEqual(events("test.fail"), ["operation.started", "operation.failed"]);
    const failed = lines.find((line) => line.operation === "test.fail" && line.event === "operation.failed");
    assert.equal(failed.stage, "two"); assert.equal(failed.extra, 7); assert.equal(failed.a, 2); assert.equal(typeof failed.durationMs, "number");
    assert.ok(!("stage" in lines.find((line) => line.operation === "test.plain" && line.event === "operation.failed")));
    assert.deepEqual(events("test.sync"), ["operation.started", "operation.completed"]);
    assert.equal(lines.find((line) => line.operation === "test.sync_fail" && line.event === "operation.failed").stage, "tx");
    assert.equal(db.all(sql`select n from op_check`).length, 1);
  } else throw new Error("Unknown scenario " + scenario);
  console.log("SCENARIO_PASSED " + scenario);
} finally { await f.close(); }
