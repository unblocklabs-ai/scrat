import { createAppAuth } from "@octokit/auth-app";
import { createHash } from "node:crypto";
import { Octokit } from "octokit";
import { config, isBotLogin } from "./config.ts";
import { recordEvent, type EventReferences, type JournalEvent } from "./events.ts";
import { labelName } from "./labels.ts";
import { logger, withOperation } from "./logging.ts";
import { endsWithMarker, fingerprintMarker, inlineCommentId, issueCommentId, reviewCommentId, withMarker } from "./markers.ts";
import type { GithubComment, GithubContext, GithubIssue, GithubItem, GithubPullRequest } from "./github-types.ts";
import { errorStatus } from "./errors.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { conditionalFetch, rateLimitLow } from "./github-http.ts";
import { assertPublishable, basicCredential, childEnvironment } from "./secrets.ts";

const permissions = {
  read: { issues: "read", pull_requests: "read", metadata: "read" },
  write: { issues: "write", pull_requests: "write", metadata: "read" },
  pull_request: { pull_requests: "write", contents: "read", metadata: "read" },
  contents_read: { contents: "read", metadata: "read" },
  contents_write: { contents: "write", metadata: "read" },
  checks: { checks: "read", metadata: "read" },
  deployments: { deployments: "write", metadata: "read" },
} as const;
let authenticate: ReturnType<typeof createAppAuth> | undefined;

type GithubEvent = Extract<JournalEvent, { type: `github.${string}` }>;
const clients = new Map<string, { token: string; github: Octokit; invalid: boolean }>();

let appVerified: Promise<void> | undefined;

const noRetry = { retry: { enabled: false }, throttle: { enabled: false } };

async function appToken(repo: string, access: keyof typeof permissions, refresh: boolean) {
  authenticate ??= createAppAuth({
    appId: config.github.appId,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    log: logger.child({ component: "github.auth" }),
  });
  const auth = authenticate;
  appVerified ??= (async () => {
    const { token: jwt } = await auth({ type: "app" });
    const { slug } = (await new Octokit({ auth: jwt, ...noRetry }).request("GET /app")).data as { slug: string };
    if (!isBotLogin(`${slug}[bot]`)) throw new Error(`GitHub App ${slug} posts as ${slug}[bot], but github.botLogin is ${config.github.botLogin}`);
  })().catch((error) => { appVerified = undefined; throw error; });
  await appVerified;
  const { token } = await authenticate({
    type: "installation",
    installationId: config.github.installationId,
    repositoryNames: [repo],
    permissions: permissions[access],
    refresh,
  });
  return token;
}

const patRejected = (error: unknown) => Object.assign(
  new Error("GitHub rejected GITHUB_PAT (401): the token is expired, revoked, lacks scope, or is not SSO-authorized", { cause: error }),
  { status: 401 },
);
let patVerified: Promise<void> | undefined;

async function verifiedPat() {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT is not set");
  patVerified ??= (async () => {
    let login: string;
    try {
      login = (await new Octokit({ auth: token, ...noRetry }).rest.users.getAuthenticated()).data.login;
    } catch (error) {
      throw errorStatus(error) === 401 ? patRejected(error) : error;
    }
    if (!isBotLogin(login)) throw new Error(`GITHUB_PAT belongs to ${login}, but github.botLogin is ${config.github.botLogin}`);
  })().catch((error) => { patVerified = undefined; throw error; });
  await patVerified;
  return token;
}

async function githubForRepository(repository: string, access: keyof typeof permissions) {
  const [owner, repo] = repository.split("/");
  const key = `${repository}:${access}`;
  const refresh = clients.get(key)?.invalid ?? false;
  const pat = config.github.auth === "pat";
  const token = pat ? await verifiedPat() : await appToken(repo, access, refresh);
  const cached = clients.get(key);
  if (cached?.token === token && !cached.invalid) return { github: cached.github, owner, repo, token };
  const github = new Octokit({
    auth: token,
    log: logger.child({ component: "octokit", repository, access }),
    ...(access !== "read" ? noRetry : { request: { fetch: conditionalFetch } }),
  });
  const entry = { token, github, invalid: false };
  github.hook.error("request", (error) => {
    if (errorStatus(error) === 401) entry.invalid = true;
    throw pat && errorStatus(error) === 401 ? patRejected(error) : error;
  });
  clients.set(key, entry);
  return { github, owner, repo, token };
}

function issueView(item: GithubIssue): GithubIssue {
  return {
    node_id: item.node_id, number: item.number, title: item.title, body: item.body,
    html_url: item.html_url, state: item.state, updated_at: item.updated_at,
    user: item.user ? { login: item.user.login } : null,
    labels: item.labels.map((label) => typeof label === "string" ? label : { name: label.name }),
  };
}

function pullRequestView(item: GithubPullRequest): GithubPullRequest {
  return { ...issueView(item), head: {
    sha: item.head.sha, ref: item.head.ref,
    repo: item.head.repo ? { full_name: item.head.repo.full_name } : null,
  }, base: { ref: item.base.ref } };
}

export async function mapConcurrent<T>(items: readonly T[], run: (item: T, index: number) => Promise<void>, stop: () => boolean = () => false) {
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(config.github.readConcurrency, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const index = next++;
      await run(items[index]!, index);
    }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
}

export class GitHubRepository {
  readonly repository: string;

  constructor(repository: string) {
    assertConfiguredRepository(repository);
    this.repository = repository;
  }

  async getGitEnvironment(write = false) {
    const { token } = await githubForRepository(this.repository, write ? "contents_write" : "contents_read");
    return {
      ...childEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicCredential(token)}`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
    };
  }

  private read() {
    return githubForRepository(this.repository, "read");
  }

  async fetchOpenItems() {
    const { github, owner, repo } = await this.read();
    const items = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: "open", per_page: 100,
    });
    const pullRequests = items.some((item) => item.pull_request)
      ? await github.paginate(github.rest.pulls.list, {
          owner, repo, state: "open", per_page: 100,
        })
      : [];
    return {
      issues: items.filter((item) => !item.pull_request).map(issueView),
      pullRequests: pullRequests.map(pullRequestView),
    };
  }

  async fetchItemContext(kind: "issue" | "pr", number: number, { comments: withComments = true, item: known }: { comments?: boolean; item?: GithubItem } = {}): Promise<GithubContext> {
    const { github, owner, repo } = await this.read();
    const when = <T>(enabled: boolean, read: () => Promise<T[]>) => enabled ? read() : Promise.resolve([] as T[]);
    const reads = [
      known ? Promise.resolve(known) : kind === "issue"
        ? github.rest.issues.get({ owner, repo, issue_number: number }).then(({ data }) => issueView(data))
        : github.rest.pulls.get({ owner, repo, pull_number: number }).then(({ data }) => pullRequestView(data)),
      when(withComments, () => github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 })),
      when(withComments && kind === "pr", () => github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 })),
      when(withComments && kind === "pr", () => github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 })),
    ] as const;
    for (const read of await Promise.allSettled(reads)) if (read.status === "rejected") throw read.reason;
    const [item, discussion, inline, reviews] = await Promise.all(reads);
    const comments: GithubComment[] = [
      ...discussion.map((comment) => ({
        id: issueCommentId(comment.id), body: comment.body ?? "", author: comment.user?.login,
        revision: comment.updated_at, url: comment.html_url,
      })),
      ...inline.map((comment) => ({
        id: inlineCommentId(comment.id), body: comment.body, author: comment.user?.login,
        revision: comment.updated_at, url: comment.html_url, path: comment.path, line: comment.line,
      })),
      ...reviews.filter((review) => review.body).map((review) => ({
        id: reviewCommentId(review.id), body: review.body, author: review.user?.login,
        revision: createHash("sha256").update(review.body).digest("hex"), url: review.html_url,
      })),
    ];
    return { item, comments };
  }

  async fetchItemContexts(items: readonly { kind: "issue" | "pr"; number: number; item?: GithubItem }[], options: { defer?: boolean } = {}) {
    const contexts = new Array<GithubContext | undefined>(items.length);
    await mapConcurrent(items, async ({ kind, number, item }, index) => {
      contexts[index] = await this.fetchItemContext(kind, number, { item });
    }, () => options.defer === true && rateLimitLow());
    return contexts;
  }

  async findPullRequest(branch: string, base: string) {
    const { github, owner, repo } = await this.read();
    const matches = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: "all", head: `${owner}:${branch}`, base, per_page: 100,
    });
    const found = matches.find((pr) => isBotLogin(pr.user?.login) && pr.head.repo?.full_name === this.repository && pr.head.ref === branch);
    return found ? pullRequestView(found) : undefined;
  }

  async checkRunConclusions(sha: string) {
    const { github, owner, repo } = await githubForRepository(this.repository, "checks");
    const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
    return runs.flatMap((run) => run.conclusion ? [{ name: run.name, conclusion: run.conclusion }] : []);
  }

  async searchIssues(query: string) {
    if (/(repo|org|user|owner):/i.test(query)) throw new Error(`The query must not contain repo:, org: or user: qualifiers; the search is limited to ${this.repository}`);
    return withOperation("github.search", { repository: this.repository }, async (operation) => {
      const { github } = await this.read();
      const response = await github.rest.search.issuesAndPullRequests({ q: `repo:${this.repository} ${query}`, per_page: config.tools.search.pageSize }).catch((error: unknown) => {
        throw errorStatus(error) === 403 || errorStatus(error) === 429 ? new Error("GitHub search rate limit reached; try again later", { cause: error }) : error;
      });
      operation.complete({ status: response.status, total: response.data.total_count });
      return {
        total: response.data.total_count,
        items: response.data.items.map((item) => ({
          number: item.number, kind: item.pull_request ? "pr" : "issue", title: item.title, state: item.state, url: item.html_url,
          author: item.user?.login, labels: item.labels.map((label) => typeof label === "string" ? label : label.name),
          updatedAt: item.updated_at, excerpt: (item.body ?? "").slice(0, config.tools.search.excerptChars),
        })),
      };
    });
  }

  private write<R extends { status: number; headers: { "x-github-request-id"?: string } }>(
    name: string,
    context: Record<string, unknown>,
    references: EventReferences,
    access: keyof typeof permissions,
    { inspect, request, journal }: {
      inspect?: () => void;
      request: (client: { github: Octokit; owner: string; repo: string }) => Promise<R>;
      journal: (response: R) => { event?: GithubEvent; details?: Record<string, unknown>; failure?: Record<string, unknown> };
    },
  ) {
    return withOperation(name, { ...references, repository: this.repository, ...context }, async (operation) => {
      if (inspect) {
        operation.stage("inspection");
        inspect();
      }
      operation.stage("authentication");
      const client = await githubForRepository(this.repository, access);
      operation.stage("request");
      const response = await request(client);
      const { event, details, failure } = journal(response);
      if (failure) operation.failure(failure);
      operation.stage("journal");
      if (event) recordEvent({ ...references, operationId: operation.operationId, ...event });
      operation.complete({ ...details, status: response.status, requestId: response.headers["x-github-request-id"] });
      return response;
    });
  }

  async postComment(issueNumber: number, body: string, references: EventReferences = {}): Promise<number> {
    const response = await this.write("github.post_comment", { issueNumber }, references, "write", {
      inspect: () => assertPublishable(body),
      request: ({ github, owner, repo }) => github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body }),
      journal: ({ data }) => ({
        event: { type: "github.comment_created", data: { repository: this.repository, issueNumber, commentId: data.id, url: data.html_url } },
        details: { commentId: data.id },
        failure: { commentId: data.id },
      }),
    });
    return response.data.id;
  }

  async updateComment(commentId: number, body: string, references: EventReferences = {}): Promise<void> {
    await this.write("github.update_comment", { commentId }, references, "write", {
      inspect: () => assertPublishable(body),
      request: ({ github, owner, repo }) => github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body }),
      journal: ({ data }) => ({
        event: { type: "github.comment_updated", data: { repository: this.repository, commentId: data.id, url: data.html_url } },
        details: { commentId: data.id },
      }),
    });
  }

  async addLabels(issueNumber: number, labels: string[], references: EventReferences = {}): Promise<void> {
    await this.write("github.add_labels", { issueNumber, labels }, references, "write", {
      request: ({ github, owner, repo }) => github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels }),
      journal: () => ({ event: { type: "github.labels_added", data: { repository: this.repository, issueNumber, labels } } }),
    });
  }

  async removeLabels(issueNumber: number, labels: string[], references: EventReferences = {}): Promise<void> {
    for (const label of labels) {
      await this.write("github.remove_label", { issueNumber, label }, references, "write", {
        request: async ({ github, owner, repo }) => {
          try {
            return await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
          } catch (error) {
            if (errorStatus(error) !== 404) throw error;
            const { data } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
            if (data.labels.some((current) => labelName(current).toLowerCase() === label.toLowerCase())) throw error;
            return { status: 404, headers: {} };
          }
        },
        journal: ({ status }) => ({ event: status === 404 ? undefined : { type: "github.label_removed", data: { repository: this.repository, issueNumber, label } } }),
      });
    }
  }

  async createDeployment({ ref, environment, description }: { ref: string; environment: string; description: string }, references: EventReferences = {}) {
    const response = await this.write("github.create_deployment", { ref, environment }, references, "deployments", {
      inspect: () => assertPublishable(description),
      request: ({ github, owner, repo }) => github.rest.repos.createDeployment({
        owner, repo, ref, environment, description, auto_merge: false, required_contexts: [], transient_environment: true, production_environment: false,
      }),
      journal: ({ data }) => "id" in data
        ? { event: { type: "github.deployment_created", data: { repository: this.repository, deploymentId: data.id, environment, ref } }, details: { deploymentId: data.id } } : {},
    });
    if (!("id" in response.data)) throw new Error(`GitHub did not create a deployment for ${ref}: ${response.data.message}`);
    return response.data.id;
  }

  async setDeploymentStatus(deploymentId: number, { state, environmentUrl, description }: { state: "success" | "failure" | "inactive"; environmentUrl?: string; description: string }, references: EventReferences = {}) {
    await this.write("github.create_deployment_status", { deploymentId, state }, references, "deployments", {
      inspect: () => assertPublishable(description, environmentUrl ?? ""),
      request: async ({ github, owner, repo }) => {
        try {
          return await github.rest.repos.createDeploymentStatus({
            owner, repo, deployment_id: deploymentId, state, description, auto_inactive: false, ...(environmentUrl ? { environment_url: environmentUrl } : {}),
          });
        } catch (error) {
          if (state !== "inactive" || errorStatus(error) !== 404) throw error;
          return { status: 404, headers: {} };
        }
      },
      journal: ({ status }) => ({ event: status === 404 ? undefined : { type: "github.deployment_status_created", data: { repository: this.repository, deploymentId, state } } }),
    });
  }

  async createIssue(
    { title, body, fingerprint }: { title: string; body: string; fingerprint: string },
    references: EventReferences = {},
  ) {
    const marked = withMarker(body, fingerprintMarker(fingerprint));
    const response = await this.write("github.create_issue", { fingerprint }, references, "write", {
      inspect: () => assertPublishable(title, marked),
      request: ({ github, owner, repo }) => github.rest.issues.create({ owner, repo, title, body: marked }),
      journal: ({ data }) => ({
        event: { type: "github.issue_created", data: { repository: this.repository, issueNumber: data.number, url: data.html_url, fingerprint } },
        details: { issueNumber: data.number },
        failure: { issueNumber: data.number },
      }),
    });
    return issueView(response.data);
  }

  async createPullRequest(
    { title, body, head, base }: { title: string; body: string; head: string; base: string },
    references: EventReferences = {},
  ) {
    const response = await this.write("github.create_pull_request", { head, base }, references, "pull_request", {
      inspect: () => assertPublishable(title, body),
      request: ({ github, owner, repo }) => github.rest.pulls.create({ owner, repo, title, body, head, base, draft: false }),
      journal: ({ data }) => ({
        event: { type: "github.pull_request_created", data: { repository: this.repository, pullRequestNumber: data.number, url: data.html_url, head, base } },
        details: { pullRequestNumber: data.number },
        failure: { pullRequestNumber: data.number },
      }),
    });
    return pullRequestView(response.data);
  }

  async upsertCommitComment(sha: string, body: string, marker: string, references: EventReferences = {}) {
    const marked = withMarker(body, marker);
    const response = await this.write("github.commit_comment", { sha }, references, "contents_write", {
      inspect: () => assertPublishable(marked),
      request: async ({ github, owner, repo }) => {
        const existing = (await github.paginate(github.rest.repos.listCommentsForCommit, { owner, repo, commit_sha: sha, per_page: 100 }))
          .findLast((comment) => isBotLogin(comment.user?.login) && endsWithMarker(comment.body, marker));
        return existing
          ? github.rest.repos.updateCommitComment({ owner, repo, comment_id: existing.id, body: marked })
          : github.rest.repos.createCommitComment({ owner, repo, commit_sha: sha, body: marked });
      },
      journal: ({ data }) => ({
        event: { type: "github.commit_comment_written", data: { repository: this.repository, sha, commentId: data.id, url: data.html_url } },
        details: { commentId: data.id },
      }),
    });
    return response.data.html_url;
  }
}
