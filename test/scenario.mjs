import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    const w = await createWorkspace({ repositoryPath: f.config.github.repositoryPath, baseRef: "origin/main" });
    const { eq } = await import("drizzle-orm");
    db.update(s.subjects).set({ workspaceId: w.id }).where(eq(s.subjects.id, "issue-8")).run();
    db.update(s.subjects).set({ workspaceId: w.id }).where(eq(s.subjects.id, "issue-9")).run();
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
      for (let sync = 0; sync < 50; sync++) await (await f.app("github-sync.ts")).syncGitHub(undefined, false);
      const snapshots = all(s.githubSnapshots);
      assert.equal(snapshots.length, 48, "Keep only the newest snapshots");
      assert.equal(snapshots.at(-1).id, Math.max(...snapshots.map((snapshot) => snapshot.id)));
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
    assert.deepEqual(queued().map((t) => [t.subjectId, t.action]).sort(), [["issue-1", "implement"], ["issue-2", "review_issue"]]);
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
    assert.ok(!queued().some((t) => t.subjectId === "issue-1"));
    const prTasks = () => queued().filter((t) => f.row(s.items, t.subjectId).kind === "pr");
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
    db.update(s.runs).set({ mainSha: "f".repeat(40) }).where(eq(s.runs.id, completed.id)).run();
    const isQueued = (id) => all(s.tasks).some((t) => t.subjectId === id && t.status === "queued");
    f.addIssue(2); await route(); assert.ok(isQueued("issue-2"));
    const claim = tasks.claimTask(); assert.equal(claim.task.subjectId, "issue-1");
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
    tasks.enqueueTask({ subjectId: prItem.id, action: "address_pr_feedback", reason: "Reply without code changes", input: {} });
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
    const itemId = f.row(s.tasks, review.taskId).subjectId;
    f.reset(201, "normal"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Manual review", input: {} });
    f.faults.label.add(201); const older = await run(); assert.ok(older.error);
    f.reset(201, "grade-A"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Newer manual review", input: {} });
    await success(); const writes = f.writes.length, inferences = f.requests.length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.writes.length, writes); assert.equal(f.requests.length, inferences);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
  } else if (scenario === "git_paging") {
    await implement(1);
    const branch = f.prs[0].head.ref;
    git(".", "clone", "-b", branch, resolve("remote.git"), "pr-edit");
    writeFileSync("pr-edit/src/huge.txt", ("b".repeat(63) + "\n").repeat(18 * 16384));
    git(resolve("pr-edit"), "add", "."); commit(resolve("pr-edit"), "Rewrite huge file"); git(resolve("pr-edit"), "push", "origin", branch);
    await route();
    const review = await success();
    const hugeSize = 64 * (17 * 16384 + 10), midSize = readFileSync("seed/src/mid.txt").length, mid = readFileSync("seed/src/mid.txt", "latin1");
    const mine = f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === "gpt-6.1-sol").at(-1);
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
  } else if (scenario === "canonical") {
    await implement(1); await route(); f.faults.comment.add(201);
    const lost = await run(); assert.ok(lost.error); assert.equal(lost.stage, "publishing");
    const original = f.comments.get(201)[0];
    const feedback = { ...original, id: 9000, body: "Feedback quoting the review:\n```\n" + original.body + "\n```\n<!-- scrat-task:feedback -->" };
    f.comments.get(201).push(feedback);
    const calls = f.requests.length; tasks.retryTask(lost.taskId); const recovered = await success();
    assert.equal(f.requests.length, calls); assert.equal(recovered.publication.commentId, original.id);
    f.reset(201, "grade-A");
    tasks.enqueueTask({ subjectId: f.row(s.tasks, lost.taskId).subjectId, action: "review_pr", reason: "New assessment", input: {} });
    f.faults.comment.add(201); const lostUpdate = await run(); assert.ok(lostUpdate.error);
    assert.deepEqual(f.prs[0].labels, [], "A lost report-write response must not leave the old report's grade");
    const updateCalls = f.requests.length; tasks.retryTask(lostUpdate.taskId); const updated = await success();
    assert.equal(f.requests.length, updateCalls); assert.equal(updated.publication.commentId, original.id);
    assert.equal(f.comments.get(201).length, 2); assert.equal(f.comments.get(201)[1].body, feedback.body);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
  } else if (scenario === "deleted_review" || scenario === "unreceipted_review") {
    await implement(1); await route(); f.faults.label.add(201);
    const older = await run(); assert.ok(older.error); assert.ok(older.publication.commentId);
    const itemId = f.row(s.tasks, older.taskId).subjectId;
    f.reset(201, "grade-A"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "New assessment", input: {} });
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
    const itemId = f.row(s.tasks, older.taskId).subjectId;
    f.reset(201, "helper-grade-A");
    tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Broader fresh review", input: {} });
    const newer = await success();
    assert.ok(newer.result.paths.includes("src/helper.ts"));
    const report = f.comments.get(201)[0].body;
    changeMain("src/helper.ts", "export const helper = 2;\n");
    const calls = f.requests.length; await route();
    assert.deepEqual(f.prs[0].labels, [], "No historical grade may replace a stale newer grade");
    assert.equal(f.comments.get(201)[0].body, report);
    assert.ok(all(s.tasks).some((t) => t.subjectId === itemId && t.action === "review_pr" && t.status === "queued"));
    tasks.cancelQueuedTasks(itemId, "Exercise an explicitly requested old publication retry", "review_pr");
    tasks.retryTask(older.taskId); const stale = await run();
    assert.match(stale.error.message, /fresh review/);
    assert.equal(f.requests.length, calls); assert.deepEqual(f.prs[0].labels, []);
    assert.equal(f.comments.get(201)[0].body, report);
  } else if (scenario === "assessment_order") {
    await implement(1); await route(); f.modes.set(201, "incomplete");
    const failed = await run(); assert.ok(failed.error); assert.notEqual(failed.stage, "publishing");
    const itemId = f.row(s.tasks, failed.taskId).subjectId;
    f.reset(201, "normal"); tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "New task", input: {} });
    const middle = await success();
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ startedAt: "2099-01-01T00:00:00Z" }).where(eq(s.runs.id, middle.id)).run();
    f.reset(201, "grade-A"); tasks.retryTask(failed.taskId); const newest = await success();
    assert.equal(newest.result.grade, "A");
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
    assert.match(f.comments.get(201)[0].body, new RegExp(newest.taskId));
    const calls = f.requests.length; await route();
    assert.equal(f.requests.length, calls);
    assert.deepEqual(f.prs[0].labels.map((l) => l.name), ["A · Strong"]);
  } else if (scenario === "manual_queue") {
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
    tasks.enqueueTask({ subjectId: itemId, action: "review_pr", reason: "Routing", input: { triggerKey: "k", changedPaths: [] } });
    const merged = f.row(s.tasks, manual.id);
    assert.equal(merged.status, "queued"); assert.deepEqual(merged.input, { triggerKey: "k", changedPaths: [], manual: true });
    await route(); assert.equal(f.row(s.tasks, manual.id).status, "queued");
    const result = await success();
    assert.equal(result.taskId, manual.id);
    assert.match(f.comments.get(201).find((c) => c.user.login !== "human").body, new RegExp(manual.id));
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
    f.prs.find((pr) => pr.number === 202).title = "Retitled after the review";
    const running = tasks.enqueueManualTasks("review_pr", ["202"])[0];
    const claimed = tasks.claimTask(); assert.equal(claimed.task.id, running.taskId);
    await route();
    assert.deepEqual(reviews2().filter((t) => t.status === "queued"), [], "a running manual review covers the sync");
  } else if (scenario === "run_sequence") {
    const { eq } = await import("drizzle-orm");
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
    const [r1, r2, r3, r4, r5] = all(s.runs).sort((a, b) => a.sequence - b.sequence);
    assert.throws(() => db.$client.exec("UPDATE runs SET sequence = 1 WHERE sequence = 2"), /UNIQUE/);
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
    assert.deepEqual(order(), [r4.id, r5.id, r2.id, r1.id, r3.id]);
    assert.deepEqual(all(s.runs).map((r) => r.sequence).sort(), [1, 2, 3, 4, 5]);
    const before = all(s.runs);
    assert.equal(ensureRunSequences(), 0); assert.deepEqual(all(s.runs), before);
    db.update(s.runs).set({ sequence: null }).where(eq(s.runs.id, r4.id)).run();
    assert.equal(ensureRunSequences(), 1); assert.equal(f.row(s.runs, r4.id).sequence, 6);
    f.enqueue(1); assert.equal(tasks.claimTask().run.sequence, 7);
  } else if (scenario === "run_latest") {
    const { eq } = await import("drizzle-orm");
    changeMain("src/helper.ts", "export const helper = 1;\n");
    f.addIssue(1); await route(); const first = await success(); assert.ok(first.result.paths.includes("src/app.ts"));
    f.enqueue(1); f.reset(1, "helper");
    const second = await success(); assert.ok(second.result.paths.includes("src/helper.ts")); assert.ok(second.sequence > first.sequence);
    db.update(s.runs).set({ startedAt: "2099-01-01T00:00:00Z" }).where(eq(s.runs.id, first.id)).run();
    db.update(s.runs).set({ startedAt: "1970-01-01T00:00:00Z" }).where(eq(s.runs.id, second.id)).run();
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.action === "review_issue" && t.status === "queued"), "The latest claimed review is the baseline");
    f.addIssue(2, ["scrat"]); f.enqueue(2, "implement"); const implemented = await success();
    const prItem = all(s.items).find((i) => i.kind === "pr");
    const feedback = async () => { tasks.enqueueTask({ subjectId: prItem.id, action: "address_pr_feedback", reason: "Reply", input: {} }); f.reset(202, "no-change"); return success(); };
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
    tasks.enqueueTask({ subjectId: f.row(s.tasks, reviewed.taskId).subjectId, action: "review_pr", reason: "Fresh review", input: {} });
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
    for (const number of [201, 202]) assert.ok(all(s.tasks).some((t) => t.status === "queued" && f.row(s.items, t.subjectId).payload.number === number));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    await route(); assert.deepEqual(f.prs[0].labels, []);
  } else if (scenario === "absent_labels") {
    f.addIssue(1); const { reconcileLabels } = await f.app("labels.ts");
    const { GitHubRepository } = await f.app("github.ts");
    const request = () => reconcileLabels(new GitHubRepository("fixture/project"), 1, { current: ["scrat"], desired: [], managed: ["scrat"] });
    const { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return write(fd, data, ...rest); };
    try { await reconcileLabels(new GitHubRepository("fixture/project"), 1, { current: ["scrat", "B"], desired: [], managed: ["scrat", "B"] }); }
    finally { fs.writeSync = write; }
    assert.deepEqual(lines.filter((line) => line.operation === "github.remove_label" && line.event === "operation.completed").map((line) => line.label), ["scrat", "B"]);
    assert.equal(all(s.events).filter((e) => e.type === "github.label_removed").length, 0);
    f.issues.get(1).labels = [{ name: "scrat" }];
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => options.method === "DELETE"
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }) : fetch(input, options);
    try { await assert.rejects(request(), (error) => error.status === 404); }
    finally { globalThis.fetch = fetch; }
    f.issues.delete(1);
    await assert.rejects(request(), (error) => error.status === 404);
  } else if (scenario === "publish_effects") {
    const { eq } = await import("drizzle-orm");
    const { pollCommits } = await f.app("commit-source.ts");
    const seed = resolve("seed"), remote = resolve("remote.git"), pushLog = resolve("pushes.log");
    writeFileSync(resolve(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> "${pushLog}"\n`, { mode: 0o755 });
    const pushes = () => existsSync(pushLog) ? readFileSync(pushLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const updates = [], update = db.update.bind(db);
    db.update = (table) => {
      const builder = update(table);
      if (table !== s.runs) return builder;
      const set = builder.set.bind(builder);
      builder.set = (values) => { updates.push(values); return set(values); };
      return builder;
    };
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
    tasks.enqueueTask({ subjectId: pr.id, action: "resolve_conflicts", reason: "Exercise comment publication", input: {} });
    const merged = await success();
    assert.deepEqual(types(mark), ["comment"]);
    assert.ok(trace[mark].pushes > pushed, "the merge is pushed before the comment is posted");
    assert.equal(merged.publication.status, "published");
    changeMain("another.txt", "another\n");
    f.faults.comment.add(201); mark = trace.length;
    tasks.enqueueTask({ subjectId: pr.id, action: "resolve_conflicts", reason: "Exercise comment receipt", input: {} });
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

    f.addIssue(3, ["human-label"]); f.modes.set(3, "ready"); f.enqueue(3); mark = trace.length;
    await success();
    assert.equal(types(mark)[0], "comment"); assert.equal(types(mark).filter((type) => type === "comment").length, 1);
    assert.ok(types(mark).slice(1).length > 0); assert.ok(types(mark).slice(1).every((type) => type === "label"), "comment first, then labels");
    f.addIssue(4, ["human-label"]); f.modes.set(4, "ready"); f.enqueue(4); f.faults.label.add(4); mark = trace.length;
    const labelFailed = await run(); assert.ok(labelFailed.error);
    assert.equal(types(mark)[0], "comment"); assert.ok(labelFailed.publication.commentId);
    mark = trace.length; tasks.retryTask(labelFailed.taskId);
    await success();
    assert.ok(types(mark).length > 0); assert.ok(types(mark).every((type) => type === "label"), "a receipted comment is skipped and labels still reconcile");

    await route(); const settled = updates.length;
    const review = await success();
    assert.equal(f.row(s.tasks, review.taskId).action, "review_pr"); assert.equal(review.publication.status, "published");
    assert.equal(updates.slice(settled).filter((values) => values.publication?.status === "published").length, 1, "reconcile alone settles the review status");
  } else if (scenario === "footer") {
    await implement(1); f.modes.set(201, "quoted-grade"); await route();
    const reviewed = await success();
    assert.equal(reviewed.result.grade, "A");
    assert.match(f.comments.get(201)[0].body, /```\nSCRAT_GRADE: F\nSCRAT_READY\n```/);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.reset(201, "quoted-only");
    tasks.enqueueTask({ subjectId: f.row(s.tasks, reviewed.taskId).subjectId, action: "review_pr", reason: "Review again", input: {} });
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
  } else if (scenario === "format_retry") {
    f.addIssue(1, ["scrat"]); f.modes.set(1, "format-once"); f.enqueue(1, "implement");
    let before = f.requests.length; const implemented = await success();
    assert.equal(f.requests.length - before, 3);
    assert.equal(implemented.result.outcome, "complete");
    const reviewCounts = () => {
      const counts = {};
      for (const r of f.requests.filter((r) => r.context.action === "review_pr")) { const k = `${r.request.model}/${r.consolidating}`; counts[k] = (counts[k] ?? 0) + 1; }
      return counts;
    };
    await route(); const first = await success();
    const normal = reviewCounts();
    assert.equal(Object.keys(normal).length, 3);
    for (const [mode, target] of [["reviewer-grade-once", "deepseek/deepseek-v4.1-flash/false"], ["consolidation-grade-once", "gpt-6.1-sol/true"]]) {
      const start = reviewCounts(); f.reset(201, mode);
      tasks.enqueueTask({ subjectId: f.row(s.tasks, first.taskId).subjectId, action: "review_pr", reason: "Review again", input: {} });
      const reviewed = await success(); const end = reviewCounts();
      for (const k of Object.keys(normal)) assert.equal(end[k] - (start[k] ?? 0), normal[k] + (k === target ? 1 : 0), `${mode} ${k}`);
      assert.equal(reviewed.result.grade, "B");
      assert.ok(reviewed.result.paths.includes("src/app.ts"));
      assert.ok(reviewed.reviewers.every((r) => !r.error));
    }
    f.addIssue(2); f.modes.set(2, "no-status"); f.enqueue(2, "implement");
    before = f.requests.length; const stuck = await run();
    assert.match(stuck.error.message, /SCRAT_STATUS/); assert.equal(f.requests.length - before, 4);
    for (const [i, mode] of ["incomplete", "needs_decision"].entries()) {
      f.addIssue(i + 3); f.modes.set(i + 3, mode); f.enqueue(i + 3, "implement");
      before = f.requests.length; const r = await run(); assert.ok(r.error);
      assert.equal(f.requests.length - before, 2);
    }
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
  } else if (scenario === "working_notes") {
    f.addIssue(1, ["scrat"]); f.modes.set(1, "notes"); f.enqueue(1, "implement"); const r = await success();
    const notes = resolve(f.row(s.workspaces, r.workspaceId).path, ".scrat/notes.md");
    const system = ({ request }) => JSON.stringify(request.messages.filter((m) => m.role === "system" || m.role === "developer"));
    const change = f.requests.filter((entry) => entry.context.action === "implement");
    assert.ok(change.length && change.every((entry) => system(entry).includes(notes.replaceAll("\\", "\\\\"))), "Every change request carries the notes path");
    assert.ok(change.every((entry) => system(entry).includes("do not say the changes are uncommitted")));
    assert.equal(readFileSync(notes, "utf8"), "Plan: change value\n");
    const commit = r.publication.publishedCommitSha;
    assert.deepEqual(git(resolve("remote.git"), "ls-tree", "-r", "--name-only", commit).split("\n").filter((path) => path.startsWith(".scrat")), []);
    assert.match(git(resolve("remote.git"), "show", `${commit}:src/app.ts`), /value = 5/);
    await route(); await success();
    const reviews = f.requests.filter((entry) => entry.context.action === "review_pr");
    assert.ok(reviews.length && reviews.every((entry) => !system(entry).includes(".scrat/notes.md")));
  } else if (scenario === "implement_base_moved") {
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
  } else if (scenario === "validation_mutation") {
    f.addIssue(1); f.enqueue(1, "implement"); const r = await run();
    assert.match(r.error.message, /Validation changed/); assert.equal(f.prs.length, 0);
  } else if (scenario === "validation_resume") {
    f.addIssue(1); f.enqueue(1, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(failed.stage, "validating");
    const calls = f.requests.length;
    assert.equal(readFileSync("prepare.log", "utf8").trim().split("\n").length, 2);
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
  } else if (scenario === "crash_before_publishing") {
    const updates = [], update = db.update.bind(db);
    db.update = (table) => {
      const builder = update(table);
      if (table !== s.runs) return builder;
      const set = builder.set.bind(builder);
      builder.set = (values) => { updates.push(values); return set(values); };
      return builder;
    };
    const validations = () => readFileSync("validations.log", "utf8").trim().split("\n").length;
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement"); f.faults.pr.add(1);
    const lost = await run(); assert.ok(lost.error); assert.equal(validations(), 1);
    const artifacts = updates.filter((values) => values.verification);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].stage, "publishing", "validated artifacts and the publishing stage are one write");
    const saved = f.row(s.runs, lost.id);
    assert.equal(saved.stage, "publishing"); assert.equal(saved.publication.commitSha, saved.headSha); assert.equal(saved.verification.headSha, saved.headSha);
    tasks.retryTask(lost.taskId); const completed = await success();
    assert.equal(validations(), 1); assert.equal(f.prs.length, 1); assert.equal(completed.publication.pullRequestNumber, 201);
    assert.equal(completed.inferenceFromRunId, lost.id);
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
      assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"), lock);
      f.reset(1, "grep"); await success();
    }
    changeMain("pnpm-lock.yaml", lock.replace("unrelated@5.0.0", "unrelated@6.0.0")); await route();
    assert.ok(!all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
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
    assert.ok(!all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
    for (const update of [
      () => bump("wrangler", "2.0.0"),
      () => { lock.importers["."].devDependencies.alternate = { specifier: "npm:wrangler@2.0.0", version: "wrangler@2.0.0" }; },
      () => { lock.importers["."].devDependencies.unrelated = { specifier: "workspace:*", version: "link:../unrelated" }; },
      () => { lock.importers["."].injectedSetting = true; },
      () => { lock.importers["."].devDependencies.unrelated = "3.0.0"; },
      () => { lock.importers["packages/new"] = {}; },
    ]) {
      update(); changeMain("pnpm-lock.yaml", JSON.stringify(lock)); await route();
      assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
      f.reset(1, "grep"); await success();
    }
  } else if (scenario === "unicode_scope") {
    f.addIssue(1); await route(); await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const special = 1;"))));
    changeMain("src/a b.ts", "export const special = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
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
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal"); let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/caf\u00e9.ts", "export const unicode = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } else if (scenario === "legacy_scope") {
    f.addIssue(1); await route(); let reviewed = await success();
    const { eq } = await import("drizzle-orm");
    for (const paths of [[".", "src/app.ts"], ["."], ["src"]]) {
      db.update(s.runs).set({ result: { ...reviewed.result, paths } }).where(eq(s.runs.id, reviewed.id)).run();
      changeMain(paths[0] === "src" ? "src/helper.ts" : "notes.md", JSON.stringify(paths)); await route();
      assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
      reviewed = await success();
    }
  } else if (scenario === "review_scope") {
    f.addIssue(1); f.modes.set(1, "at"); await route();
    const reviewed = await success(); assert.ok(reviewed.result.paths.includes("src/app.ts"));
    changeMain("src/app.ts", "export const value = 9;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-1" && t.status === "queued"));
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
    const { eq } = await import("drizzle-orm");
    for (const t of all(s.tasks).filter((t) => t.action === "review_pr")) db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, t.id)).run();
    const failed = await run(); assert.ok(failed.error);
    const w = f.row(s.workspaces, original.workspaceId);
    assert.ok(await (await f.app("git.ts")).hasPendingMerge(w.path));
    f.reset(201, "normal"); tasks.retryTask(failed.taskId); const recovered = await success();
    assert.equal(f.requests.findLast((r) => r.context.action === "resolve_conflicts").context.workspace.mergeInProgress, true);
    assert.equal(git(w.path, "show", "-s", "--format=%P").split(" ").length, 2);
    assert.equal(recovered.workspaceId, original.workspaceId);
  } else if (scenario === "stale_branch" || scenario === "stale_branch_scrat") {
    const { eq } = await import("drizzle-orm");
    const remoteGit = (...args) => git(resolve("remote.git"), ...args);
    const needs = (name) => writeFileSync(`require-${name}`, "");
    const branchOff = (branch, path, text) => {
      git(resolve("seed"), "switch", "-c", branch); writeFileSync(resolve("seed", path), text);
      git(resolve("seed"), "add", "."); commit(resolve("seed"), "Branch " + branch);
      git(resolve("seed"), "push", resolve("remote.git"), branch); git(resolve("seed"), "switch", "main");
    };
    const addPr = (number, branch, login) => f.prs.push({ id: number, node_id: "PR_" + number, number, title: "PR " + number, body: "", state: "open",
      html_url: `https://github.com/fixture/project/pull/${number}`, labels: [], updated_at: "2026-10-19T00:00:00Z", user: { login },
      head: { ref: branch, sha: remoteGit("rev-parse", branch), repo: { full_name: "fixture/project" } }, base: { ref: "main", repo: { full_name: "fixture/project" } } });
    const prItem = (n) => all(s.items).find((i) => i.kind === "pr" && i.payload.number === n);
    const queuedFor = (n) => all(s.tasks).filter((t) => t.subjectId === prItem(n).id && t.status === "queued").map((t) => t.action).sort();
    const drainExcept = (n) => { for (const item of all(s.items)) if (item.id !== prItem(n).id) tasks.cancelQueuedTasks(item.id, "Isolate"); };
    const parents = (cwd, rev) => git(cwd, "show", "-s", "--format=%P", rev).split(" ");
    const checkout = f.config.github.repositoryPath;
    const mainHead = () => git(resolve("seed"), "rev-parse", "main");
    if (scenario === "stale_branch") {
      branchOff("feature-a", "src/feature.ts", "export const feature = 1;\n");
      branchOff("feature-b", "src/app.ts", "export const value = 7;\n");
      needs("needed.txt");
      changeMain("needed.txt", "ok\n");
      addPr(301, "feature-a", "human"); await route();
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
      assert.equal(git(checkout, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
      f.prs[0].state = "closed"; await route();
      changeMain("src/app.ts", "export const value = 9;\n");
      addPr(302, "feature-b", "human"); await route();
      const calls = f.requests.length, heads2 = remoteGit("for-each-ref", "refs/heads");
      const conflicted = await run();
      assert.equal(conflicted.error.message, "PR branch is behind main and does not merge cleanly; the author needs to update it");
      assert.equal(f.requests.length, calls); assert.equal(remoteGit("for-each-ref", "refs/heads"), heads2);
      assert.equal(f.comments.get(302)?.length ?? 0, 0);
      assert.ok(all(s.workspaces).every((w) => w.removedAt));
      f.prs[1].state = "closed"; await route();
      branchOff("feature-c", "src/c.ts", "export const c = 1;\n"); needs("needed4.txt");
      addPr(303, "feature-c", "human"); await route();
      const workspaces = all(s.workspaces).length, unmasked = await run();
      assert.match(unmasked.error.message, /ERR_MISSING needed4\.txt/); assert.equal(f.requests.length, calls);
      assert.equal(all(s.workspaces).length, workspaces + 1, "no synthetic workspace is made");
    } else {
      await implement(1); await route(); drainExcept(201);
      const pr = f.prs[0];
      needs("needed.txt"); changeMain("needed.txt", "ok\n");
      tasks.cancelQueuedTasks(prItem(201).id, "Fresh start"); await route();
      assert.deepEqual(queuedFor(201), ["review_pr"], "a clean, behind branch is not updated before anything fails");
      const calls = f.requests.length, staleHead = remoteGit("rev-parse", pr.head.ref);
      const failed = await run();
      assert.match(failed.error.message, /ERR_MISSING needed\.txt/); assert.equal(failed.stage, "preparing"); assert.equal(failed.headSha, staleHead);
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
      await implement(2); drainExcept(202);
      changeMain("bad.txt", "bad\n"); writeFileSync("require-validation", "");
      const fallback = tasks.enqueueTask({ subjectId: prItem(202).id, action: "resolve_conflicts", reason: "Exercise fallback", input: {} });
      f.reset(202, "remove-bad");
      const repaired = await success(); assert.equal(repaired.taskId, fallback.id);
      const request = f.requests.findLast((r) => r.context.action === "resolve_conflicts" && r.context.item.number === 202);
      assert.match(readFileSync(request.context.files.validationFailure, "utf8"), /bad\.txt must not exist/);
      assert.equal(request.context.workspace.mergeInProgress, false);
      assert.equal(parents(f.row(s.workspaces, repaired.workspaceId).path, request.context.workspace.headSha).length, 2, "the agent starts from the merge commit");
      const head2 = remoteGit("rev-parse", f.prs[1].head.ref);
      remoteGit("merge-base", "--is-ancestor", mainHead(), head2);
      assert.throws(() => remoteGit("cat-file", "-e", head2 + ":bad.txt"));
      unlinkSync("require-validation");
      await implement(3); drainExcept(203);
      needs("needed2.txt"); changeMain("needed2.txt", "ok\n"); changeMain("src/app.ts", "export const value = 99;\n");
      tasks.enqueueTask({ subjectId: prItem(203).id, action: "resolve_conflicts", reason: "Exercise bug fix", input: {} });
      f.reset(203, "resolve"); const resolved = await success();
      assert.ok(f.requests.some((r) => r.context.action === "resolve_conflicts" && r.context.item.number === 203));
      const head3 = remoteGit("rev-parse", f.prs[2].head.ref);
      assert.equal(parents(resolve("remote.git"), head3).length, 2);
      assert.equal(remoteGit("show", head3 + ":src/app.ts"), "export const value = 300;"); assert.equal(resolved.publication.publishedCommitSha, head3);
      assert.equal(remoteGit("log", "-1", "--format=%s", head3), f.prs[2].title, "A PR's commit keeps its title's single conventional prefix");
      await implement(4); drainExcept(204);
      needs("needed3.txt"); changeMain("needed3.txt", "ok\n");
      tasks.enqueueTask({ subjectId: prItem(204).id, action: "address_pr_feedback", reason: "Exercise self-heal", input: {} });
      f.reset(204, "normal"); const healed = await success();
      const head4 = remoteGit("rev-parse", f.prs[3].head.ref);
      remoteGit("merge-base", "--is-ancestor", mainHead(), head4);
      assert.equal(healed.publication.publishedCommitSha, head4); assert.equal(remoteGit("show", head4 + ":src/app.ts"), "export const value = 214;");
      assert.equal(remoteGit("show", head4 + ":needed3.txt"), "ok");
    }
  } else if (scenario === "reopen") {
    const original = await implement(1); await route();
    f.prs[0].state = "closed"; await route(); assert.ok(f.row(s.workspaces, original.workspaceId).removedAt);
    f.prs[0].state = "open"; await (await f.app("github-sync.ts")).syncGitHub(undefined, false); await route();
    const pr = all(s.items).find((i) => i.kind === "pr"); assert.equal(f.row(s.subjects, pr.id).workspaceId, null);
    assert.ok(all(s.tasks).some((t) => t.subjectId === pr.id && t.status === "queued"));
  } else if (scenario === "sync_missing_item") {
    f.addIssue(1); f.addIssue(2); await route();
    f.issues.delete(1); f.addIssue(3); await route();
    assert.equal(f.row(s.subjects, "issue-1").state, "closed"); assert.equal(f.row(s.subjects, "issue-2").state, "open");
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-3" && t.status === "queued"));
  } else if (scenario === "existing_pr") {
    await implement(1); f.addIssue(2, ["scrat"]); f.prs[0].body += "\nFixes #2";
    f.enqueue(2, "implement"); await route();
    assert.ok(!all(s.tasks).some((t) => t.subjectId === "issue-2" && t.status === "queued"));
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
  } else if (scenario === "trigger_inputs") {
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
    ];
    for (const member of members) assert.deepEqual(parseTriggerInput(member), member);
    const legacy = (input, expected) => assert.deepEqual(parseTriggerInput(input), { ...input, ...expected });
    legacy({ triggerKey: "k", revision: "r", mainSha: "m", changedPaths: [] }, { source: "github_items", kind: "item_changed" });
    legacy({ triggerKey: "k", mainSha: "m" }, { source: "github_items", kind: "label" });
    legacy({ triggerKey: "k", mainSha: "m", headSha: "h" }, { source: "github_items", kind: "pr_conflicts" });
    legacy({ triggerKey: "k", commentRevisions: [] }, { source: "github_items", kind: "pr_feedback" });
    legacy({ triggerKey: "a", assessmentRunId: "a", grade: "F" }, { source: "github_items", kind: "low_grade" });
    legacy({ manual: true }, { source: "github_items", kind: "manual" });
    legacy({}, { source: "github_items", kind: "manual" });
    legacy({ kind: "commit", triggerKey: "s", sha: "s", previousSha: "p", branch: "main", commitCount: 1, truncated: true }, { source: "github_commits" });
    legacy({ triggerKey: "k", revision: "r", mainSha: "m", manual: true }, { source: "github_items", kind: "item_changed" });
    assert.throws(() => parseTriggerInput(null), /must be an object/);
    assert.throws(() => parseTriggerInput([]), /must be an object/);
    assert.throws(() => parseTriggerInput({ kind: "schedule" }), /Unknown trigger kind: "schedule"/);
    assert.throws(() => parseTriggerInput({ source: "schedule", kind: "label", triggerKey: "k", mainSha: "m" }), /Unknown trigger source for label: "schedule"/);
    assert.throws(() => parseTriggerInput({ triggerKey: "k", commentRevisions: "c@1" }), /Invalid github_items\/pr_feedback trigger input at \/commentRevisions/);
    assert.throws(() => parseTriggerInput({ kind: "commit", sha: "s" }), /Invalid github_commits\/commit trigger input/);
    for (let n = 1; n <= 2; n++) f.addIssue(n);
    db.$client.prepare("INSERT INTO tasks (id, subject_id, action, priority, reason, input, created_at) VALUES ('malformed', 'issue-1', 'review_issue', 1000, 'Integration', '{\"triggerKey\":\"k\",\"commentRevisions\":7}', '2026-01-01')").run();
    f.enqueue(2);
    assert.equal(tasks.claimTask().task.subjectId, "issue-2");
    assert.equal(f.row(s.tasks, "malformed").status, "failed");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1); assert.match(rejected[0].data.reason, /^Invalid trigger input for review_issue: .*commentRevisions/);
  } else if (scenario === "rejection") {
    const { eq } = await import("drizzle-orm");
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

    f.enqueue(3); const damaged = tasks.claimTask();
    tasks.finishRun(damaged.run.id, { status: "failed", error: new Error("Interrupted") });
    db.update(s.runs).set({ sequence: null }).where(eq(s.runs.id, damaged.run.id)).run();
    assert.throws(() => tasks.retryTask(damaged.task.id, "validation"), /Validation-only retry requires/);
    assert.throws(() => tasks.retryTask("bogus", "validation"), /Validation-only retry requires/);
    tasks.retryTask(damaged.task.id); f.enqueue(4);
    assert.equal(tasks.claimTask().task.subjectId, "issue-4");
    assert.equal(f.row(s.tasks, damaged.task.id).status, "failed");
    assert.match(rejections().at(-1).data.reason, /Missing run sequence/);
    assert.equal(rejections().at(-1).taskId, damaged.task.id);
    assert.equal(rejections().length, 3);

    const { config: live } = await f.app("config.ts"); live.actions.review_pr.thinkingLevel = "turbo";
    f.addIssue(5); f.addIssue(6); f.enqueue(5, "review_pr"); f.enqueue(6);
    assert.equal(tasks.claimTask().task.subjectId, "issue-6");
    assert.equal(f.row(s.tasks, all(s.tasks).find((t) => t.subjectId === "issue-5").id).status, "failed");
    assert.match(rejections().at(-1).data.reason, /Invalid thinking level for review_pr: turbo/);
    live.actions.review_pr.thinkingLevel = "high";

    const { validateStaticConfig } = await f.app("startup.ts");
    await validateStaticConfig(f.config);
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.implement.thinkingLevel = "turbo"; })), /implement: invalid thinking level turbo/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.github.auth = "token"; })), /github\.auth must be "app" or "pat"/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.github.botLogin = " "; })), /github\.botLogin must not be empty/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.github.botName = " !! "; })), /github\.botName must contain a letter or digit/);
    const key = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    await assert.rejects(validateStaticConfig(f.config), /github\.auth is "app" but GITHUB_APP_PRIVATE_KEY is not set/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.github.auth = "pat"; })), /github\.auth is "pat" but GITHUB_PAT is not set/);
    process.env.GITHUB_PAT = "ghp_x"; await validateStaticConfig(variant((c) => { c.github.auth = "pat"; })); delete process.env.GITHUB_PAT;
    process.env.GITHUB_APP_PRIVATE_KEY = key;
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_pr.reviewers[1].thinkingLevel = "turbo"; })), /review_pr reviewer 2: invalid thinking level/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_issue.model = "missing-model"; })), /review_issue: no Pi model fixture\/missing-model/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.review_pr.reviewers[0].provider = "nowhere"; })), /review_pr reviewer 1: no Pi model nowhere/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.resolve_conflicts.skill = "skills/missing/SKILL.md"; })), /resolve_conflicts: skill file not found/);
  } else if (scenario === "slack_client") {
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
  } else if (scenario === "slack_startup") {
    const { validateStaticConfig } = await f.app("startup.ts");
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    const enabled = (change = () => {}) => variant((c) => {
      Object.assign(c.actions.review_base_change, { enabled: true, channel: "C0123456789", skill: "skills/review_issue/SKILL.md" }); change(c.actions.review_base_change);
    });
    await validateStaticConfig(f.config);
    assert.equal(f.slack.calls.length, 0);
    delete process.env.SLACK_BOT_TOKEN;
    await assert.rejects(validateStaticConfig(enabled()), /review_base_change: SLACK_BOT_TOKEN is not set/);
    process.env.SLACK_BOT_TOKEN = ["xoxb", "1111", "2222", "fixturetoken"].join("-");
    await validateStaticConfig(enabled());
    assert.deepEqual(f.slack.calls.map((call) => call.method), ["auth.test"]);
    await validateStaticConfig(enabled((a) => { a.agent = "panel"; a.reviewers = structuredClone(f.config.actions.review_pr.reviewers); }));
    await assert.rejects(validateStaticConfig(enabled((a) => { a.channel = " "; })), /channel must not be empty/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.branch = "develop"; })), /branch must equal github\.baseBranch/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.startMessage = "{{bot}} saw {{commit}}"; })), /unknown startMessage variable \{\{commit\}\}/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.agent = "panel"; })), /requires exactly two reviewers/);
    await assert.rejects(validateStaticConfig(enabled((a) => { a.agent = "solo"; })), /agent must be "single" or "panel"/);
    f.slack.fail = "invalid_auth";
    await assert.rejects(validateStaticConfig(enabled()), /Slack auth\.test failed: .*invalid_auth/);
    f.slack.fail = null;
    delete process.env.SLACK_BOT_TOKEN;
    const calls = f.slack.calls.length;
    await validateStaticConfig(variant((c) => { c.actions.review_base_change.channel = ""; c.actions.review_base_change.startMessage = "{{nope}}"; }));
    assert.equal(f.slack.calls.length, calls);
    const { config: live, isActionEnabled } = await f.app("config.ts");
    assert.equal(isActionEnabled("review_base_change"), false);
    assert.equal(isActionEnabled("review_issue"), true);
    f.addIssue(1); f.enqueue(1, "review_base_change"); f.addIssue(2); f.enqueue(2);
    assert.equal(tasks.claimTask().task.subjectId, "issue-2");
    const rejected = all(s.events).filter((e) => e.type === "task.rejected");
    assert.equal(rejected.length, 1); assert.equal(rejected[0].data.reason, "Unknown action: review_base_change");
    assert.equal(f.row(s.tasks, rejected[0].taskId).status, "failed");
    live.actions.review_base_change.enabled = true;
    f.addIssue(3); f.enqueue(3, "review_base_change");
    assert.equal(tasks.claimTask().task.action, "review_base_change");
    assert.equal(f.slack.calls.length, calls);
  } else if (scenario === "slack_redaction") {
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
  } else if (scenario === "single_repository") {
    const { eq } = await import("drizzle-orm");
    const { syncGitHub } = await f.app("github-sync.ts");
    const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = (...args) => { calls.push(args[0]); return realFetch(...args); };
    for (const other of ["other/repo", "Fixture/Project2"]) {
      await assert.rejects(syncGitHub(other), /serves only fixture\/project/);
      await assert.rejects(syncGitHub(other, false), /serves only fixture\/project/);
    }
    const { GitHubRepository } = await f.app("github.ts");
    assert.throws(() => new GitHubRepository("other/repo"), /serves only fixture\/project/);
    assert.equal(calls.length, 0); assert.equal(all(s.githubSnapshots).length, 0); assert.equal(all(s.items).length, 0);
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
    f.addIssue(3); f.addIssue(4); f.enqueue(3); f.enqueue(4);
    db.update(s.subjects).set({ repository: "" }).where(eq(s.subjects.id, "issue-3")).run();
    db.update(s.subjects).set({ repository: "" }).where(eq(s.subjects.id, "issue-4")).run();
    assert.equal(tasks.claimTask(), undefined);
    const bad = all(s.events).filter((e) => e.type === "task.rejected").slice(1);
    assert.equal(bad.length, 2);
    for (const e of bad) assert.match(e.data.reason, /Subject has no parseable repository/);

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
    assert.ok(all(s.tasks).some((t) => t.subjectId === "issue-2" && t.status === "queued"));
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
  } else if (scenario === "self_repair") {
    const prItem = (n) => all(s.items).find((i) => i.kind === "pr" && i.payload.number === n);
    const repairs = (n) => all(s.tasks).filter((t) => t.subjectId === prItem(n).id && t.action === "address_review");
    const count = (n) => db.$client.prepare("select self_repair_count as c from items where id = ?").get(prItem(n).id).c;
    const review = async (n, mode) => { f.reset(n, mode); await route(); return success(); };
    await implement(1); const graded = await review(201, "grade-C");
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
    assert.equal(f.comments.get(201).length, 2); assert.match(f.comments.get(201)[1].body, /Implemented the change/);
    await route(); assert.equal(all(s.tasks).filter((t) => t.status === "queued").length, 0, "A reply-only repair leaves the assessment current and cannot retrigger");
    assert.equal(repairs(201).length, 1); assert.equal(count(201), 1);
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(201).id); await route();
    assert.ok(f.prs.find((pr) => pr.number === 201).labels.some((label) => label.name === "Scrat repair exhausted"), "A last repair that changed nothing still marks the PR");
    await implement(2); await review(202, "normal"); await route(); assert.equal(repairs(202).length, 0, "Grade B does not trigger");
    await implement(3); f.prs.find((pr) => pr.number === 203).user.login = "human";
    await review(203, "grade-C"); await route(); assert.equal(repairs(203).length, 0, "Human-authored PRs never trigger");
    await implement(4); await review(204, "grade-C");
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(204).id);
    const labels204 = () => f.prs.find((pr) => pr.number === 204).labels.map((label) => label.name).filter((name) => name === "Scrat repair exhausted").length;
    assert.equal(labels204(), 0, "Below the cap there is no exhausted label");
    await route(); assert.equal(repairs(204).length, 0, "The cap blocks further repairs");
    assert.equal(labels204(), 1, "A low grade at the cap is labelled");
    const labelEvents = () => all(s.events).filter((event) => event.type.startsWith("github.labels_") && JSON.stringify(event.data).includes("Scrat repair exhausted")).length;
    const written = labelEvents(); await route(); assert.equal(labels204(), 1); assert.equal(labelEvents(), written, "A steady state writes no label");
    db.$client.prepare("update items set self_repair_count = 1 where id = ?").run(prItem(204).id);
    await route(); assert.equal(repairs(204).length, 1); assert.equal(count(204), 1);
    const queuedRepair = repairs(204)[0], before = count(204);
    tasks.enqueueTask({ subjectId: queuedRepair.subjectId, action: "address_review", reason: "Coalesce", input: queuedRepair.input });
    assert.equal(count(204), before, "A coalesced repair does not spend a cap slot");
    assert.throws(() => tasks.enqueueManualTasks("address_review", ["204"]), /queued automatically/);
    f.prs.find((pr) => pr.number === 204).title = "Retitled after the review"; await route();
    assert.equal(repairs(204)[0].status, "cancelled", "A repair for a stale assessment is cancelled");
    assert.equal(labels204(), 1, "The label waits for the next review");
    db.$client.prepare("update items set self_repair_count = 2 where id = ?").run(prItem(204).id);
    await success(); await route(); assert.equal(repairs(204).length, 1, "A new low grade at the cap queues nothing");
    assert.equal(labels204(), 1, "Still low at the cap");
    f.prs.find((pr) => pr.number === 204).title = "Retitled again"; await route(); f.reset(204, "normal"); assert.equal((await success()).result.grade, "B"); await route();
    assert.equal(labels204(), 0, "A better grade removes the label");
    await implement(5);
    f.comments.set(205, [{ id: 9100, body: "Please rename it", user: { login: "human" }, updated_at: "2026-10-19T01:00:00Z", html_url: "https://github.com/fixture/project/pull/205#comment" }]);
    assert.equal((await review(205, "grade-C")).result.grade, "C"); await route();
    assert.ok(all(s.tasks).some((t) => t.subjectId === prItem(205).id && t.action === "address_pr_feedback" && t.status === "queued"));
    assert.equal(repairs(205).length, 0, "Pending human feedback goes first");
    tasks.cancelQueuedTasks(prItem(205).id, "Drain"); await implement(6); await review(206, "grade-C"); await route(); assert.equal(repairs(206)[0].status, "queued");
    f.comments.set(206, [{ id: 9200, body: "Please rename it", user: { login: "human" }, updated_at: "2026-10-19T01:00:00Z", html_url: "https://github.com/fixture/project/pull/206#comment" }]);
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
    tasks.cancelQueuedTasks(prItem(210).id, "Human feedback", "address_review"); assert.equal(repairs(210)[0].status, "cancelled");
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
  } else if (scenario === "review_prior_assessment") {
    const review = async (n, mode) => { f.reset(n, mode); await route(); return success(); };
    const filesOf = (assessmentId) => f.requests.filter((r) => r.context.action === "review_pr" && r.context.item.number === 201 && r.context.files.directory.includes(assessmentId));
    await implement(1); const first = await review(201, "grade-C");
    const firstRequests = f.requests.filter((r) => r.context.action === "review_pr");
    assert.ok(firstRequests.some((r) => r.consolidating));
    for (const request of firstRequests) assert.ok(!("previous_assessment" in request.context.files) && !("previous_repair" in request.context.files), "A first review has no prior state");
    await route(); f.reset(201, "normal"); const repair = await success();
    assert.equal(repair.taskId, all(s.tasks).find((t) => t.action === "address_review").id); assert.ok(repair.result.text.includes("Implemented the change"));
    await route(); f.reset(201, "normal"); const second = await success();
    assert.notEqual(second.id, first.id);
    const secondRequests = filesOf(second.id);
    assert.equal(new Set(secondRequests.filter((r) => !r.consolidating).map((r) => r.request.model)).size, 2); assert.ok(secondRequests.some((r) => r.consolidating));
    for (const request of secondRequests) {
      assert.ok(!("history" in request.context.files), "PR reviews keep the #50 files instead of a history file");
      assert.equal(readFileSync(request.context.files.previous_assessment, "utf8"), first.result.text);
      assert.equal(readFileSync(request.context.files.previous_repair, "utf8"), repair.result.text);
    }
    await implement(2); f.prs.find((pr) => pr.number === 202).user.login = "human";
    await review(202, "normal"); tasks.enqueueManualTasks("review_pr", ["202"]); await success();
    assert.ok(f.requests.filter((r) => r.context.item.number === 202 && r.context.action === "review_pr").every((r) => !("previous_assessment" in r.context.files)), "Human PRs never get prior state");
  } else if (scenario === "issue_effect") {
    const { applyEffects } = await f.app("effects.ts");
    const { GitHubRepository } = await f.app("github.ts");
    const github = new GitHubRepository("fixture/project");
    const created = () => f.writes.filter((write) => write.type === "issue");
    const apply = async (saved, receipts = {}) => {
      let publication = { status: "pending", ...receipts };
      await applyEffects("issue-report", { references: {}, publication: () => publication, saveReceipt: (patch) => { publication = { ...publication, ...patch }; }, github, run: saved });
      return publication;
    };
    const reporting = (saved, ...issues) => ({ ...saved, result: { ...saved.result, issues: issues.map(([fingerprint, title]) => ({ title, fingerprint, body: `Body of ${title}` })) } });
    const marker = (fingerprint) => `<!-- scrat-fingerprint:${fingerprint} -->`;

    f.addIssue(1); f.modes.set(1, "issues"); f.enqueue(1);
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

    f.addIssue(2); f.modes.set(2, "issues-quoted"); f.enqueue(2);
    assert.equal((await success()).result.issues, undefined, "a quoted block creates nothing");
    f.addIssue(3); f.modes.set(3, "issues-bad"); f.enqueue(3);
    const before = f.requests.length, bad = await run();
    assert.match(bad.error.message, /fingerprint/); assert.equal(f.requests.length - before, 4, "a malformed block gets the correction turns");
  } else if (scenario === "history_file") {
    const { eq } = await import("drizzle-orm");
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
    assert.ok(last.indexOf("report 11") < last.indexOf("report 10") && last.indexOf("report 10") < last.indexOf("report 3"), "newest first");
    assert.ok(!/report 1\b/.test(last), "the history keeps the newest ten runs");
    assert.equal((last.match(/^## /gm) ?? []).length, 10);
    const { r: huge, request } = await review(1);
    assert.match(request.context.files.history, /history\.md$/);
    rewrite(huge, "x".repeat(200 * 1024));
    await review(1);
    const capped = seen.at(-1);
    assert.ok(Buffer.byteLength(capped) <= 64 * 1024 && Buffer.byteLength(capped) > 60 * 1024, Buffer.byteLength(capped) + capped.slice(0, 300));
    assert.ok(capped.includes("## ") && !capped.includes("report 10"), "a report over the cap crowds out older ones");
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
    const { containsSecret } = await f.app("secrets.ts"), body = key.split("\n").slice(1, -2).join("");
    assert.ok(containsSecret(`x ${body.slice(0, 40)} x`) && containsSecret(`x ${body.slice(10, 50)} x`) && containsSecret(`x ${body.slice(20, 60)} x`));
    assert.ok(!containsSecret(body.slice(0, 39)));
    const { redactSecrets } = await f.app("errors.ts"), header = Buffer.from("x-access-token:" + f.pat).toString("base64");
    assert.ok(containsSecret(f.pat) && containsSecret(header));
    assert.ok(!redactSecrets(`${f.pat} ${header}`).includes(f.pat.slice(4)) && !redactSecrets(header).includes(header.slice(8)));
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
    const aborted = await timed(((waiting) => { controller.abort(); return waiting; })(waitForWork(workGeneration(), 5_000, controller.signal)));
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
    for (const number of [201, 202]) {
      assert.equal(count(since, new RegExp(`/pulls/${number}$`)), 1);
      assert.equal(count(since, new RegExp(`/issues/${number}/comments`)), 1);
      assert.equal(count(since, new RegExp(`/pulls/${number}/(comments|reviews)`)), 2);
    }
    for (const number of [10, 11]) {
      assert.equal(count(since, new RegExp(`/issues/${number}$`)), 0);
      assert.equal(count(since, new RegExp(`/issues/${number}/comments`)), 1);
    }
    since = f.calls.length; await route();
    assert.ok(reads(since).length >= 12);
    assert.deepEqual(reads(since).filter((call) => call.status !== 304), []);
    const remaining = f.rate.remaining; await route(); assert.equal(f.rate.remaining, remaining, "304s do not consume the rate limit");
    f.comments.set(202, [{ id: 900, body: "Please rename this", user: { login: "human" }, updated_at: "2026-10-19T02:00:00Z", html_url: "https://github.com/fixture/project/pull/202#c900" }]);
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
    f.rate.remaining = 5000; since = f.calls.length; await route();
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
        f.comments.set(201, [{ id: 901, body: "Changed so reads are not 304", user: { login: "human" }, updated_at: "2026-10-19T03:00:00Z", html_url: "https://github.com/fixture/project/pull/201#c901" }]);
        await assert.rejects(route(), (error) => error.status === 404);
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
  } else if (scenario === "validation_feedback" || scenario === "validation_feedback_cap") {
    const { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return write(fd, data, ...rest); };
    const validations = () => existsSync("validations.log") ? readFileSync("validations.log", "utf8").trim().split("\n").length : 0;
    const lastUser = ({ request }) => { const { content } = request.messages.at(-1); return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n"); };
    const feedbackRequests = () => f.requests.filter((entry) => entry.request.messages.at(-1).role === "user" && lastUser(entry).startsWith(`${f.config.github.botName}'s validation failed`));
    try {
      if (scenario === "validation_feedback") {
        f.addIssue(1, ["scrat"]); f.modes.set(1, "feedback-fix"); f.enqueue(1, "implement"); const r = await success();
        assert.equal(r.verification.headSha, r.publication.publishedCommitSha); assert.equal(validations(), 2);
        assert.equal(readdirSync("data/pi-sessions", { recursive: true }).filter((name) => name.endsWith(".jsonl")).length, 1);
        const [message] = feedbackRequests(), text = lastUser(message);
        assert.equal(feedbackRequests().length, 1); assert.equal(f.requests.length, 4, "one tool turn and one answer for each of the agent and its feedback");
        assert.match(text, /round 1 of 2/); assert.match(text, /Exit code: 7/); assert.match(text, /Verification failed: marker present/); assert.ok(text.length < 20_000);
        assert.ok(!text.includes("ghs_fixture_sensitive")); assert.match(text, /validation detail/);
        assert.equal(git(resolve("remote.git"), "rev-list", "--count", `main..${f.prs[0].head.ref}`), "1");
        assert.ok(!existsSync(resolve(f.row(s.workspaces, r.workspaceId).path, "fail-validation")));
        assert.ok(lines.some((line) => line.event === "pi.validation_retry" && line.round === 1));
        assert.match(r.result.text, /^Implemented the change\./);
        assert.match(r.result.text, /\*\*Validation correction 1:\*\* Fixed the validation failure\./);
        assert.match(f.prs[0].body, /Implemented the change\.[\s\S]*Fixed the validation failure\./);
      } else {
        f.addIssue(1, ["scrat"]); f.modes.set(1, "feedback-stubborn"); f.enqueue(1, "implement"); const failed = await run();
        assert.equal(failed.error.exitCode, 7); assert.equal(failed.verification, null); assert.equal(f.prs.length, 0);
        assert.equal(validations(), 3); assert.equal(feedbackRequests().length, 2);
        assert.equal(lines.filter((line) => line.event === "pi.validation_retry").length, 2);
        assert.match(lastUser(feedbackRequests()[1]), /round 2 of 2/);
        writeFileSync("kill-validation", ""); f.addIssue(2, ["scrat"]); f.enqueue(2, "implement");
        const calls = f.requests.length, before = validations(), killed = await run();
        assert.ok(killed.error); assert.equal(killed.error.name, "Error"); assert.equal(killed.error.exitCode, undefined); assert.equal(killed.stage, "validating");
        assert.equal(validations(), before + 1); assert.equal(f.requests.length, calls + 2, "agent turn only"); assert.equal(feedbackRequests().length, 2);
        rmSync("kill-validation"); writeFileSync("exit-137", ""); f.addIssue(3, ["scrat"]); f.enqueue(3, "implement");
        const wrapped = await run();
        assert.equal(wrapped.error.exitCode, 137); assert.equal(f.requests.length, calls + 4, "agent turn only"); assert.equal(feedbackRequests().length, 2);
      }
    } finally { fs.writeSync = write; }
  } else if (scenario === "command_timeout") {
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
    const started = Date.now(), failed = await run();
    assert.ok(Date.now() - started < 20_000);
    assert.ok(failed.error); assert.equal(failed.error.exitCode, undefined); assert.equal(failed.stage, "validating");
    assert.match(failed.error.message, /timed out after 1 seconds/);
    assert.equal(f.requests.length, 2, "agent turn only");
    assert.equal(f.prs.length, 0);
    tasks.retryTask(failed.taskId, "validation");
    assert.equal(f.row(s.tasks, failed.taskId).status, "queued");
  } else if (scenario === "deploy_stop_boundary") {
    const validations = () => existsSync("validations.log") ? readFileSync("validations.log", "utf8").trim().split("\n").length : 0;
    const events = (type) => all(s.events).filter((event) => event.type === type);
    f.addIssue(1, ["scrat"]); f.enqueue(1, "implement");
    const stop = new AbortController(); f.onModel = () => stop.abort();
    const cut = await f.runNextTask(stop.signal); f.onModel = undefined;
    assert.equal(cut.error.code, "RUN_INTERRUPTED"); assert.equal(cut.stage, "validating");
    assert.equal(f.row(s.tasks, cut.taskId).status, "queued"); assert.equal(f.row(s.tasks, cut.taskId).retryMode, "validation");
    const agentRequests = f.requests.length; assert.ok(agentRequests > 0); assert.equal(validations(), 0); assert.equal(f.prs.length, 0);
    assert.equal(events("run.interrupting").length, 1); assert.equal(events("run.interrupting")[0].runId, cut.id);
    assert.equal(events("run.requeued")[0].runId, cut.id); assert.equal(events("run.requeued")[0].taskId, cut.taskId);
    assert.equal(events("run.failed").length, 0);
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
    const { default: fs } = await import("node:fs"), write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string" && data.includes("validation.waiting")) waiting.abort(); return write(fd, data, ...rest); };
    let slotted; try { slotted = await f.runNextTask(waiting.signal); } finally { fs.writeSync = write; release(); await holder; }
    assert.equal(slotted.error.code, "RUN_INTERRUPTED"); assert.equal(slotted.stage, "validating"); assert.equal(validations(), counted);
    assert.equal(f.row(s.tasks, slotted.taskId).status, "queued"); assert.equal(f.row(s.tasks, slotted.taskId).retryMode, "validation");
  } else if (scenario === "deploy_stop_agent_timeout") {
    f.addIssue(1, ["scrat"]); f.modes.set(1, "stall"); f.enqueue(1, "implement");
    const stop = new AbortController(); f.onModel = () => stop.abort();
    const started = Date.now(), cut = await f.runNextTask(stop.signal);
    assert.ok(Date.now() - started < 20_000);
    assert.equal(cut.error.code, "RUN_INTERRUPTED"); assert.match(cut.error.message, /1 seconds after the worker was told to stop/);
    assert.equal(cut.stage, "agent"); assert.equal(f.row(s.tasks, cut.taskId).status, "queued"); assert.equal(f.row(s.tasks, cut.taskId).retryMode, "repair");
    assert.equal(f.requests.length, 1); assert.equal(f.prs.length, 0);
    assert.deepEqual(all(s.events).filter((event) => event.type.startsWith("run.") && event.runId === cut.id).map((event) => event.type), ["run.started", "run.interrupting", "run.requeued"]);
    f.onModel = undefined; f.modes.delete(1);
    const restarted = await run();
    assert.equal(restarted.retryOfRunId, null); assert.equal(f.requests.length, 2);
  } else if (scenario === "agent_timeout") {
    f.addIssue(1, ["scrat"]); f.modes.set(1, "stall"); f.enqueue(1, "implement");
    const started = Date.now(), failed = await run();
    assert.ok(Date.now() - started < 20_000);
    assert.equal(failed.error.code, "AGENT_TIMEOUT"); assert.match(failed.error.message, /exceeded 1 seconds/);
    assert.equal(f.requests.length, 1); assert.equal(f.prs.length, 0);
  } else if (scenario === "bash_guard") {
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
    const { validateStaticConfig } = await f.app("startup.ts");
    await validateStaticConfig(f.config);
    const variant = (change) => { const copy = structuredClone(f.config); change(copy); return copy; };
    await assert.rejects(validateStaticConfig(variant((c) => { c.harness.maxConcurrentValidations = 0; })), /maxConcurrentValidations must be a positive integer/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.harness.commandTimeoutSeconds = 0; })), /commandTimeoutSeconds must be a positive integer/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.harness.agentTimeoutSeconds = 1.5; })), /agentTimeoutSeconds must be a positive integer/);
    await assert.rejects(validateStaticConfig(variant((c) => { c.workspace.heavyCommands = ["^(unclosed"]; })), /heavyCommands\[0\] is not a valid regular expression/);
    for (const disabled of [null, ""]) await validateStaticConfig(variant((c) => { c.actions.address_review.exhaustedLabel = disabled; }));
    await assert.rejects(validateStaticConfig(variant((c) => { c.actions.address_review.exhaustedLabel = 5; })), /exhaustedLabel must be a string, or null or "" to disable it/);
    const { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return write(fd, data, ...rest); };
    const toolResults = () => JSON.stringify(f.requests.findLast((entry) => entry.request.messages.some((message) => message.role === "tool")).request.messages.filter((message) => message.role === "tool"));
    const attempt = async (number, mode) => { f.addIssue(number, ["scrat"]); f.modes.set(number, mode); f.enqueue(number, "implement"); return run(); };
    let nohup, background, foreground, nohupSeen, backgroundSeen;
    try { nohup = await attempt(1, "heavy"); nohupSeen = toolResults(); background = await attempt(2, "heavy-bg"); backgroundSeen = toolResults(); foreground = await attempt(3, "heavy-fg"); } finally { fs.writeSync = write; }
    const workspaceOf = (r) => f.row(s.workspaces, r.workspaceId).path;
    assert.ok(nohup.error);
    const failed = lines.find((line) => line.event === "pi.tool_failed");
    assert.ok(failed && failed.tool === "bash" && /pnpm verify/.test(failed.command) && /foreground/.test(failed.error), JSON.stringify(failed));
    for (const seen of [nohupSeen, backgroundSeen]) assert.match(seen, /runs a background job/);
    assert.ok(!existsSync(resolve(workspaceOf(nohup), "log")), "the backgrounded command must not run");
    assert.ok(background.error);
    assert.ok(!existsSync(resolve(workspaceOf(background), ".scrat/heavy-bg")), "the backgrounded command must not run");
    assert.equal(lines.filter((line) => line.event === "pi.command_blocked").length, 2);
    assert.equal(lines.filter((line) => line.event === "pi.heavy_command" && /heavy-bg/.test(line.command)).length, 0);
    assert.equal(foreground.error, null, JSON.stringify(foreground.error));
    assert.ok(existsSync(resolve(workspaceOf(foreground), ".scrat/heavy-fg")));
    const queued = lines.filter((line) => line.event === "pi.heavy_command");
    assert.equal(queued.length, 1); assert.match(queued[0].command, /^touch \.scrat\/heavy-fg$/); assert.equal(typeof queued[0].waitedMs, "number");
    assert.ok(lines.some((line) => line.event === "validation.started" && line.runId === foreground.id), "the heavy command took a validation slot");
  } else if (scenario === "validation_slots") {
    const { config } = await f.app("config.ts");
    const intervals = (skip) => readFileSync("validations.log", "utf8").trim().split("\n").slice(skip).map(JSON.parse).sort((a, b) => a.s - b.s);
    const both = (first) => { for (const n of [first, first + 1]) { f.addIssue(n, ["scrat"]); f.enqueue(n, "implement"); } return Promise.all([f.runNextTask(), f.runNextTask()]); };
    writeFileSync("slow", "");
    config.harness.maxConcurrentValidations = 1;
    const { default: fs } = await import("node:fs"), lines = [], write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => { if (fd === 2 && typeof data === "string") { lines.push(...data.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })); return data.length; } return write(fd, data, ...rest); };
    try { for (const r of await both(1)) assert.equal(r.error, null, JSON.stringify(r.error)); } finally { fs.writeSync = write; }
    assert.ok(lines.some((line) => line.event === "validation.waiting" && line.position === 1), "the waiting run logs its own place in line");
    const serial = intervals(0); assert.equal(serial.length, 2); assert.ok(serial[0].e <= serial[1].s, "one slot serializes validations");
    config.harness.maxConcurrentValidations = 2;
    for (const r of await both(3)) assert.equal(r.error, null, JSON.stringify(r.error));
    const parallel = intervals(2); assert.equal(parallel.length, 2); assert.ok(parallel[1].s < parallel[0].e, "two slots overlap validations");
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
  } else if (scenario === "pat_auth") {
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
    f.comments.get(201).push({ id: 9001, body: "Please rename the value", user: { login: "human" }, updated_at: "2026-10-19T01:00:00Z", html_url: "https://github.com/fixture/project/pull/201#comment" });
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
  } else if (scenario === "bot_name") {
    const drain = async () => { for (let n = 0; n < 12 && all(s.tasks).some((t) => t.status === "queued"); n++) await success(); };
    f.addIssue(1, ["scrat"]); f.modes.set(1, "feedback-fix"); f.enqueue(1, "implement"); await success();
    f.addIssue(2); f.enqueue(2, "review_issue"); await success();
    await route(); await drain();
    f.comments.get(201).push({ id: 9001, body: "Please rename the value", user: { login: "human" }, updated_at: "2026-10-19T01:00:00Z", html_url: "https://github.com/fixture/project/pull/201#comment" });
    await route(); await drain();
    const { eq } = await import("drizzle-orm");
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
  } else if (scenario === "bot_identity_names") {
    const queued = () => all(s.tasks).filter((t) => t.status === "queued");
    f.addIssue(1, ["scrat"]); f.addIssue(2, ["mocha-agent"]); await route();
    assert.deepEqual(queued().map((t) => [t.subjectId, t.action]).sort(), [["issue-1", "review_issue"], ["issue-2", "implement"]]);
    assert.equal(queued().find((t) => t.subjectId === "issue-2").reason, "Issue has the mocha-agent label");
    await success(); await success();
    const labels = (n) => f.issues.get(n).labels.map((label) => label.name);
    f.addIssue(3); f.modes.set(3, "ready"); f.enqueue(3, "review_issue"); await success();
    assert.deepEqual(labels(3), ["mocha-agent"]);
    f.reset(3, "normal"); f.enqueue(3, "review_issue"); await success();
    assert.deepEqual(labels(3), []);
    assert.equal(f.prs.length, 1); assert.match(f.prs[0].head.ref, /^mocha-agent\/[0-9a-f-]{36}$/);
    assert.deepEqual(labels(1), ["scrat"]);
  } else if (scenario === "config_overrides") {
    const local = resolve("app/scrat.local.json");
    const probe = (overrides, code) => {
      if (overrides === undefined) rmSync(local, { force: true }); else writeFileSync(local, JSON.stringify(overrides));
      const script = `const { config } = await import(${JSON.stringify(resolve("app/src/config.ts"))}); ${code}`;
      return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    const rejected = (overrides, message) => assert.throws(() => probe(overrides, ""), (error) => message.test(error.stderr));
    const defaults = JSON.parse(readFileSync("app/scrat.config.json", "utf8"));
    const merged = JSON.parse(probe({
      harness: { maxConcurrency: 8 }, github: { auth: "pat" }, actions: { implement: { model: "other-model" } },
      workspace: { environment: { EXTRA: "1" }, heavyCommands: ["^only$"], database: null },
    }, "console.log(JSON.stringify(config));"));
    assert.equal(merged.harness.maxConcurrency, 8); assert.equal(merged.harness.logLevel, defaults.harness.logLevel);
    assert.equal(merged.github.auth, "pat"); assert.equal(defaults.github.auth, "app"); assert.equal(merged.github.botLogin, defaults.github.botLogin);
    assert.equal(merged.actions.implement.model, "other-model");
    assert.deepEqual({ ...merged.actions.implement, model: defaults.actions.implement.model }, defaults.actions.implement);
    assert.deepEqual(merged.workspace.environment, { ...defaults.workspace.environment, EXTRA: "1" });
    assert.deepEqual(merged.workspace.heavyCommands, ["^only$"]); assert.equal(merged.workspace.database, null);
    assert.deepEqual(merged.workspace.validate, defaults.workspace.validate);

    probe(undefined, ""); assert.equal(readFileSync(local, "utf8"), "{}\n");
    rejected({ harness: { maxConcurency: 8 } }, /Unknown setting in scrat\.local\.json: harness\.maxConcurency/);
    rejected({ actions: { bogus: {} } }, /Unknown setting in scrat\.local\.json: actions\.bogus/);
    rejected({ harness: 8 }, /must be an object: harness/);
    rejected({ harness: null }, /must be an object: harness/);
    rejected({ harness: { toString: 1 } }, /Unknown setting in scrat\.local\.json: harness\.toString/);
    rejected(JSON.parse('{"workspace":{"environment":{"__proto__":{"x":"1"}}}}'), /Unknown setting in scrat\.local\.json: workspace\.environment\.__proto__/);

    const provider = Object.keys(defaults.providers)[0], model = defaults.providers[provider].models[0].id;
    const seen = probe({ providers: { [provider]: { baseUrl: "http://override.invalid/v1" } } }, `
      const { sharedModelRuntime } = await import(${JSON.stringify(resolve("app/src/model-runtime.ts"))});
      const runtime = await sharedModelRuntime(); console.log("BASE " + runtime.getModel(${JSON.stringify(provider)}, ${JSON.stringify(model)})?.baseUrl);`);
    assert.match(seen, /^BASE http:\/\/override\.invalid\/v1$/m);
    const written = JSON.parse(readFileSync("data/pi-models.json", "utf8")).providers[provider];
    assert.equal(written.baseUrl, "http://override.invalid/v1"); assert.equal(written.apiKey, defaults.providers[provider].apiKey);
    assert.deepEqual(written.models, defaults.providers[provider].models);
  } else if (scenario === "commits_source") {
    const { eq } = await import("drizzle-orm");
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
    assert.equal(task.reason, "main moved to " + first.slice(0, 7)); assert.equal(task.status, "queued"); assert.equal(task.priority, 30);
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
    live.actions.review_base_change.enabled = false;
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), []);
    changeMain("src/five.ts", "export const five = 1;\n");
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), []); assert.equal(reviews().length, 4);
    live.actions.review_base_change.enabled = true;
    assert.equal(await pollCommits(), 0); assert.deepEqual(cursor(), [tip()]); assert.equal(reviews().length, 4);
    assert.equal(db.select().from(s.sourceCursors).where(eq(s.sourceCursors.branch, "main")).all().length, 1);
    live.actions.review_base_change.maxRangeCommits = 1; const beforeCap = tip();
    changeMain("src/six.ts", "export const six = 1;\n"); changeMain("src/seven.ts", "export const seven = 1;\n");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().length, 5);
    const capped = tip();
    assert.deepEqual(reviews().find((t) => t.input.sha === capped).input, { source: "github_commits", kind: "commit", triggerKey: capped, sha: capped, previousSha: beforeCap, branch: "main", commitCount: 2, truncated: true });
    assert.deepEqual(cursor(), [capped]);
    db.update(s.sourceCursors).set({ sha: "0".repeat(40) }).run();
    assert.equal(await pollCommits(), 0); assert.equal(reviews().length, 5); assert.deepEqual(cursor(), [capped]);
    changeMain("src/eight.ts", "export const eight = 1;\n");
    assert.equal(await pollCommits(), 1); assert.equal(reviews().length, 6);
  } else if (scenario.startsWith("commit_review_")) {
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
    const bot = f.config.github.botName;
    assert.equal(await pollCommits(), 0); assert.equal(f.slack.calls.length, 0);
    const previous = tip();
    if (scenario === "commit_review_e2e") {
      assert.equal(await push("Fix a<b & c>d"), 1);
      const head = tip(); assert.equal(f.slack.calls.length, 0);
      const r = await success();
      assert.equal(posts().length, 2); const [root, reply] = posts();
      assert.deepEqual(root.body, {
        channel, unfurl_links: false, unfurl_media: false, link_names: false,
        text: `${bot}: \`main\` moved to <https://github.com/fixture/project/commit/${head}|${head.slice(0, 7)}> by Fixture (1 commit(s)): Fix a&lt;b &amp; c&gt;d. Reviewing the change.`,
      });
      assert.equal(reply.body.thread_ts, "1700000000.000001"); assert.equal(reply.body.text, "Independent review from gpt-6.1-sol. &lt;!channel&gt;");
      assert.ok(posts().every((call) => call.token === process.env.SLACK_BOT_TOKEN));
      const [thread] = all(s.slackThreads); assert.equal(all(s.slackThreads).length, 1);
      assert.deepEqual({ subjectId: thread.subjectId, channel: thread.channel, ts: thread.ts }, { subjectId: all(s.tasks)[0].subjectId, channel, ts: "1700000000.000001" });
      assert.equal(r.publication.slackReplyTs, "1700000000.000002"); assert.equal(r.publication.status, "published");
      assert.equal(r.stage, "publishing"); assert.equal(r.result.text, "Independent review from gpt-6.1-sol. <!channel>"); assert.deepEqual(r.result.paths.filter((path) => path === "src/app.ts"), ["src/app.ts"]);
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
    } else if (scenario === "commit_review_panel") {
      assert.equal(await push("Panel change"), 1);
      const r = await success();
      assert.equal(r.reviewers.length, 2); assert.ok(r.reviewers.every((reviewer) => reviewer.result?.outcome === "complete"));
      assert.equal(new Set([...r.reviewers.map((reviewer) => reviewer.piSessionId), r.piSessionId]).size, 3);
      const requests = reviewRequests(), consolidation = requests.filter((request) => request.consolidating);
      assert.equal(new Set(requests.filter((request) => !request.consolidating).map((request) => request.request.model)).size, 2);
      assert.ok(consolidation.length > 0); assert.ok(consolidation.every((request) => !request.text.includes("Grade only from findings") && !request.text.includes("include SCRAT_GRADE")));
      assert.ok(requests.every((request) => request.context.diffBaseSha === previous));
      assert.equal(r.result.grade, undefined); assert.equal(r.result.text, "Consolidated source-verified review.");
      assert.equal(posts().length, 2); assert.equal(posts()[1].body.text, "Consolidated source-verified review."); assert.equal(posts()[1].body.thread_ts, "1700000000.000001");
      assert.equal(f.writes.length, 0);
    } else if (scenario === "commit_review_slack_down") {
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
      const added = f.slack.calls.slice(mark);
      assert.equal(added.length, 3); assert.equal(added.filter((call) => call.body.thread_ts === undefined).length, 1);
      const second = all(s.slackThreads).find((row) => row.subjectId === f.row(s.tasks, failed.taskId).subjectId);
      assert.equal(added[2].body.thread_ts, second.ts); assert.equal(retried.publication.slackReplyTs, "1700000000.000004");
      assert.equal(all(s.slackThreads).length, 2); assert.equal(f.writes.length, 0);
    } else if (scenario === "commit_review_restart") {
      assert.equal(await push("Restart"), 1);
      const claim = tasks.claimTask();
      const { postMessage } = await f.app("slack.ts");
      const ts = await postMessage({ channel, text: "root" });
      db.insert(s.slackThreads).values({ subjectId: claim.subject.id, channel, ts }).run();
      execFileSync(process.execPath, [resolve("app/src/recover.ts"), claim.run.id], { stdio: "pipe" });
      const interrupted = f.row(s.runs, claim.run.id); assert.equal(interrupted.error.code, "RUN_INTERRUPTED");
      tasks.retryTask(interrupted.taskId);
      const done = await success();
      assert.equal(done.retryOfRunId, interrupted.id); assert.equal(roots().length, 1); assert.equal(posts().length, 2);
      assert.equal(posts()[1].body.thread_ts, ts); assert.equal(all(s.slackThreads).length, 1); assert.equal(done.publication.slackReplyTs, "1700000000.000002");
      assert.equal(reviewRequests().length, 4);
    } else if (scenario === "commit_review_isolation") {
      const token = process.env.SLACK_BOT_TOKEN, { childEnvironment } = await f.app("secrets.ts");
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
      assert.equal(existsSync("prepare.log"), false);
      assert.equal(posts().length, 2); assert.equal(f.writes.length, 0);
    }
  } else if (scenario === "subjects_migration") {
    const script = fileURLToPath(new URL("../deploy/migrate-subjects.mjs", import.meta.url));
    const parent = readFileSync(fileURLToPath(new URL("parent-schema.sql", import.meta.url)), "utf8");
    const migrate = (path) => JSON.parse(execFileSync(process.execPath, [script, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").at(-1));
    assert.equal(migrate("missing.sqlite").result, "no_database"); assert.equal(existsSync("missing.sqlite"), false);
    const fresh = new DatabaseSync("fresh.sqlite"); fresh.exec("CREATE TABLE unrelated (id text)"); fresh.close();
    assert.equal(migrate("fresh.sqlite").result, "fresh_database");

    const legacy = new DatabaseSync("legacy.sqlite");
    legacy.exec("PRAGMA foreign_keys = ON"); legacy.exec(parent);
    const sha1 = "a".repeat(40), sha2 = "b".repeat(40);
    const github = (number, path) => JSON.stringify({ node_id: "N" + number, number, title: "Title " + number, html_url: `https://github.com/fixture/project/${path}/${number}`, state: "open", updated_at: "2026-10-19T00:00:00Z", labels: [], user: { login: "human" } });
    const commitPayload = (sha, title) => JSON.stringify({ node_id: "commit:" + sha, number: 0, title, html_url: `https://github.com/fixture/project/commit/${sha}`, state: "open", updated_at: "2026-10-19T00:00:00Z", user: { login: "Fixture" }, labels: [] });
    legacy.exec("INSERT INTO workspaces (id, repository_path, branch, path, base_ref, base_sha, created_at) VALUES ('w1', '/r', 'scrat/w1', '/w1', 'origin/main', 'abc', '2026-01-01')");
    const addItem = legacy.prepare("INSERT INTO items (id, source, external_id, kind, state, workspace_id, self_repair_count, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    addItem.run("issue-a", "github", "N1", "issue", "open", null, 0, github(1, "issues"));
    addItem.run("pr-b", "github", "N2", "pr", "open", "w1", 2, github(2, "pull"));
    addItem.run("issue-c", "github", "N3", "issue", "closed", null, 0, github(3, "issues"));
    addItem.run("commit-d", "git", "commit:main:" + sha1, "commit", "open", null, 0, commitPayload(sha1, "First change"));
    addItem.run("commit-e", "git", "commit:release/1.0:" + sha2, "commit", "open", null, 0, commitPayload(sha2, "Second change"));
    const addTask = legacy.prepare("INSERT INTO tasks (id, item_id, action, priority, reason, input, status, created_at) VALUES (?, ?, ?, 10, 'Integration', '{}', ?, '2026-10-19T00:00:00Z')");
    for (const [id, item, action, status] of [
      ["t1", "issue-a", "review_issue", "completed"], ["t2", "issue-a", "review_issue", "queued"], ["t3", "pr-b", "review_pr", "running"],
      ["t4", "pr-b", "address_review", "queued"], ["t5", "issue-c", "review_issue", "cancelled"], ["t6", "commit-d", "review_base_change", "completed"],
      ["t7", "commit-e", "review_base_change", "queued"],
    ]) addTask.run(id, item, action, status);
    const addRun = legacy.prepare("INSERT INTO runs (id, task_id, sequence, skill, provider, model, thinking_level, workspace_id, publication) VALUES (?, ?, ?, 'review', 'p', 'm', 'high', ?, '{\"status\":\"pending\"}')");
    addRun.run("r1", "t1", 1, null); addRun.run("r3", "t3", 2, "w1"); addRun.run("r6", "t6", 3, null);
    const addEvent = legacy.prepare("INSERT INTO events (created_at, type, item_id, task_id, run_id, data) VALUES ('2026-10-19T00:00:00Z', ?, ?, ?, ?, '{}')");
    addEvent.run("task.enqueued", "issue-a", "t1", null); addEvent.run("run.started", "pr-b", "t3", "r3"); addEvent.run("run.started", "commit-d", "t6", "r6"); addEvent.run("database.created", null, null, null);
    legacy.exec("INSERT INTO slack_threads (item_id, channel, ts, created_at) VALUES ('commit-d', 'C1', '1700000000.000001', '2026-10-19T00:00:00Z')");
    legacy.exec("INSERT INTO source_cursors (repository, action, branch, sha, updated_at) VALUES ('fixture/project', 'review_base_change', 'main', '" + sha1 + "', '2026-10-19T00:00:00Z')");
    legacy.close();
    copyFileSync("legacy.sqlite", "orphan.sqlite");

    const rows = (database, query, ...args) => JSON.parse(JSON.stringify(database.prepare(query).all(...args)));
    const dump = (database) => JSON.stringify(rows(database, "SELECT type, name, sql FROM sqlite_master ORDER BY name").map((entry) => [entry, entry.type === "table" ? rows(database, `SELECT * FROM "${entry.name}"`) : null]));
    const before = new DatabaseSync("legacy.sqlite");
    const oldTasks = rows(before, "SELECT id, item_id AS subject_id FROM tasks ORDER BY id"), oldEvents = rows(before, "SELECT id, item_id AS subject_id FROM events ORDER BY id");
    const oldRuns = rows(before, "SELECT * FROM runs ORDER BY id"), oldItems = rows(before, "SELECT id, external_id, self_repair_count, payload FROM items WHERE kind != 'commit' ORDER BY id");
    const oldCursors = rows(before, "SELECT * FROM source_cursors"); before.close();

    const ghost = new DatabaseSync("orphan.sqlite");
    ghost.exec("PRAGMA foreign_keys = OFF");
    ghost.exec("INSERT INTO tasks (id, item_id, action, priority, reason, input, status, created_at) VALUES ('t-ghost', 'ghost', 'review_issue', 1, 'x', '{}', 'failed', '2026-10-19')");
    ghost.close();
    assert.throws(() => migrate("orphan.sqlite"), (error) => /1 tasks rows reference an item with no subject/.test(error.stderr));
    const untouched = new DatabaseSync("orphan.sqlite");
    assert.deepEqual(rows(untouched, "SELECT name FROM sqlite_master WHERE name = 'subjects'"), []);
    assert.ok(rows(untouched, "PRAGMA table_info(tasks)").some((column) => column.name === "item_id")); assert.equal(rows(untouched, "SELECT count(*) AS n FROM items")[0].n, 5);
    untouched.close();

    assert.deepEqual(migrate("legacy.sqlite"), { migrate: "subjects", result: "migrated", subjects: 5, commits: 2, tasks: 7, events: 4, slack_threads: 1 });
    const after = new DatabaseSync("legacy.sqlite");
    assert.deepEqual(rows(after, "SELECT id, repository, kind, key, state, workspace_id, metadata FROM subjects ORDER BY id"), [
      { id: "commit-d", repository: "fixture/project", kind: "commit", key: "main:" + sha1, state: "open", workspace_id: null, metadata: JSON.stringify({ title: "First change", author: "Fixture", url: `https://github.com/fixture/project/commit/${sha1}` }) },
      { id: "commit-e", repository: "fixture/project", kind: "commit", key: "release/1.0:" + sha2, state: "open", workspace_id: null, metadata: JSON.stringify({ title: "Second change", author: "Fixture", url: `https://github.com/fixture/project/commit/${sha2}` }) },
      { id: "issue-a", repository: "fixture/project", kind: "item", key: "N1", state: "open", workspace_id: null, metadata: null },
      { id: "issue-c", repository: "fixture/project", kind: "item", key: "N3", state: "closed", workspace_id: null, metadata: null },
      { id: "pr-b", repository: "fixture/project", kind: "item", key: "N2", state: "open", workspace_id: "w1", metadata: null },
    ]);
    assert.ok(rows(after, "SELECT created_at FROM subjects").every((row) => row.created_at));
    assert.deepEqual(rows(after, "SELECT id, external_id, self_repair_count, payload FROM items ORDER BY id"), oldItems);
    assert.deepEqual(rows(after, "PRAGMA table_info(items)").map((column) => column.name), ["id", "source", "external_id", "kind", "self_repair_count", "payload"]);
    assert.deepEqual(rows(after, "SELECT id, subject_id FROM tasks ORDER BY id"), oldTasks);
    assert.deepEqual(rows(after, "SELECT id, subject_id FROM events ORDER BY id"), oldEvents);
    assert.deepEqual(rows(after, "SELECT subject_id, channel, ts FROM slack_threads"), [{ subject_id: "commit-d", channel: "C1", ts: "1700000000.000001" }]);
    assert.deepEqual(rows(after, "SELECT * FROM runs ORDER BY id"), oldRuns); assert.deepEqual(rows(after, "SELECT * FROM source_cursors"), oldCursors);
    assert.deepEqual(rows(after, "PRAGMA foreign_key_check"), []);
    assert.deepEqual(rows(after, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'tasks_queued%'"), [{ name: "tasks_queued_subject_action_unique" }]);
    assert.throws(() => after.exec("INSERT INTO tasks (id, subject_id, action, priority, reason, input, status, created_at) VALUES ('dup', 'issue-a', 'review_issue', 1, 'x', '{}', 'queued', 'now')"), /UNIQUE/);
    assert.throws(() => after.exec("INSERT INTO subjects (id, repository, kind, key, created_at) VALUES ('dup', 'fixture/project', 'item', 'N1', 'now')"), /UNIQUE/);
    const migrated = dump(after); after.close();

    assert.deepEqual(migrate("legacy.sqlite"), { migrate: "subjects", result: "already_migrated" });
    const again = new DatabaseSync("legacy.sqlite"); assert.equal(dump(again), migrated); again.close();

    const push = execFileSync(process.execPath, [resolve("app/node_modules/drizzle-kit/bin.cjs"), "push", "--dialect=sqlite", "--schema=./app/src/schema.ts", "--url=./legacy.sqlite"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(push, /No changes detected/);
    const pushed = new DatabaseSync("legacy.sqlite"); assert.equal(dump(pushed), migrated); assert.deepEqual(rows(pushed, "PRAGMA foreign_key_check"), []); pushed.close();
  } else throw new Error("Unknown scenario " + scenario);
  console.log("SCENARIO_PASSED " + scenario);
} finally { await f.close(); }
