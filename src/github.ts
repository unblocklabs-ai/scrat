import { createAppAuth } from "@octokit/auth-app";
import { createHash } from "node:crypto";
import { Octokit } from "octokit";
import { config } from "./config.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { logger, startOperation } from "./logging.ts";
import type { GithubComment, GithubContext, GithubIssue, GithubPullRequest } from "./github-types.ts";

const permissions = {
  read: { issues: "read", pull_requests: "read", metadata: "read" },
  write: { issues: "write", pull_requests: "write", metadata: "read" },
  pull_request: { pull_requests: "write", contents: "read", metadata: "read" },
  contents_read: { contents: "read", metadata: "read" },
  contents_write: { contents: "write", metadata: "read" },
} as const;
let authenticate: ReturnType<typeof createAppAuth> | undefined;
const clients = new Map<string, { token: string; github: Octokit; invalid: boolean }>();

async function githubForRepository(repository: string, access: keyof typeof permissions) {
  const [owner, repo] = repository.split("/");
  const key = `${repository}:${access}`;
  const refresh = clients.get(key)?.invalid ?? false;
  // Retain Octokit's scoped token cache and concurrent-auth deduplication.
  authenticate ??= createAppAuth({
    appId: config.github.appId,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    log: logger.child({ component: "github.auth" }),
  });
  const { token } = await authenticate({
    type: "installation",
    installationId: config.github.installationId,
    repositoryNames: [repo],
    permissions: permissions[access],
    refresh,
  });
  // Other callers may have populated the client while authentication awaited.
  const cached = clients.get(key);
  if (cached?.token === token && !cached.invalid) return { github: cached.github, owner, repo, token };
  const github = new Octokit({
    auth: token,
    // Cached clients must not retain the first caller's operation/run identity.
    log: logger.child({ component: "octokit", repository, access }),
    ...(access !== "read" ? { retry: { enabled: false }, throttle: { enabled: false } } : {}),
  });
  const entry = { token, github, invalid: false };
  github.hook.error("request", (error) => {
    // Recover on the next operation; never replay a possibly ambiguous write.
    // An old client's failure cannot invalidate a replacement's credentials.
    if ("status" in error && error.status === 401) entry.invalid = true;
    throw error;
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

export class GitHubRepository {
  readonly repository: string;

  constructor(repository: string) { this.repository = repository; }

  async getGitEnvironment(write = false) {
    const { token } = await githubForRepository(this.repository, write ? "contents_write" : "contents_read");
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }

  async fetchOpenItems() {
    const { github, owner, repo } = await githubForRepository(this.repository, "read");
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
      snapshot: { items, pullRequests },
    };
  }

  async fetchItemContext(kind: "issue" | "pr", number: number, includeComments = true): Promise<GithubContext> {
    const { github, owner, repo } = await githubForRepository(this.repository, "read");
    const item = kind === "issue"
      ? issueView((await github.rest.issues.get({ owner, repo, issue_number: number })).data)
      : pullRequestView((await github.rest.pulls.get({ owner, repo, pull_number: number })).data);
    const comments: GithubComment[] = [];
    if (!includeComments) return { item, comments };
    comments.push(...(await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }))
      .map((comment) => ({
        id: `issue:${comment.id}`, body: comment.body ?? "", author: comment.user?.login,
        revision: comment.updated_at, url: comment.html_url,
      })));
    if (kind === "pr") {
      const inline = await github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 });
      comments.push(...inline.map((comment) => ({
        id: `inline:${comment.id}`, body: comment.body, author: comment.user?.login,
        revision: comment.updated_at, url: comment.html_url, path: comment.path, line: comment.line,
      })));
      const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
      comments.push(...reviews.filter((review) => review.body).map((review) => ({
        id: `review:${review.id}`, body: review.body, author: review.user?.login,
        revision: createHash("sha256").update(review.body).digest("hex"), url: review.html_url,
      })));
    }
    return { item, comments };
  }

  async fetchItemContexts(items: readonly { kind: "issue" | "pr"; number: number }[], includeComments = true) {
    const contexts = new Array<GithubContext>(items.length);
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        contexts[index] = await this.fetchItemContext(items[index].kind, items[index].number, includeComments);
      }
    }));
    // Await all readers even on error, so a failed sync leaves no background reads.
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
    return contexts;
  }

  async findPullRequest(branch: string, base: string) {
    const { github, owner, repo } = await githubForRepository(this.repository, "read");
    const matches = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: "all", head: `${owner}:${branch}`, base, per_page: 100,
    });
    const found = matches.find((pr) => pr.user?.login === config.github.botLogin && pr.head.repo?.full_name === this.repository && pr.head.ref === branch);
    return found ? pullRequestView(found) : undefined;
  }

  async postComment(issueNumber: number, body: string, references: EventReferences = {}) {
    const { repository } = this;
    const operation = startOperation("github.post_comment", { ...references, repository, issueNumber });
    const eventReferences = { ...references, operationId: operation.operationId };
    let stage = "authentication";
    let commentId: number | undefined;
    try {
      const { github, owner, repo } = await githubForRepository(repository, "write");
      stage = "request";
      const response = await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
      commentId = response.data.id;
      stage = "journal";
      recordEvent({ ...eventReferences, type: "github.comment_created", data: {
        repository, issueNumber, commentId, url: response.data.html_url,
      } });
      operation.complete({ commentId, status: response.status, requestId: response.headers["x-github-request-id"] });
      return response;
    } catch (error) {
      operation.fail(error, { stage, commentId });
      throw error;
    }
  }

  async updateComment(commentId: number, body: string, references: EventReferences = {}) {
    const { repository } = this;
    const operation = startOperation("github.update_comment", { ...references, repository, commentId });
    const eventReferences = { ...references, operationId: operation.operationId };
    let stage = "authentication";
    try {
      const { github, owner, repo } = await githubForRepository(repository, "write");
      stage = "request";
      const response = await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
      stage = "journal";
      recordEvent({ ...eventReferences, type: "github.comment_updated", data: {
        repository, commentId: response.data.id, url: response.data.html_url,
      } });
      operation.complete({ commentId: response.data.id, status: response.status, requestId: response.headers["x-github-request-id"] });
      return response;
    } catch (error) {
      operation.fail(error, { stage });
      throw error;
    }
  }

  async addLabels(issueNumber: number, labels: string[], references: EventReferences = {}) {
    const { repository } = this;
    const operation = startOperation("github.add_labels", { ...references, repository, issueNumber, labels });
    const eventReferences = { ...references, operationId: operation.operationId };
    let stage = "authentication";
    try {
      const { github, owner, repo } = await githubForRepository(repository, "write");
      stage = "request";
      const response = await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
      stage = "journal";
      recordEvent({ ...eventReferences, type: "github.labels_added", data: { repository, issueNumber, labels } });
      operation.complete({ status: response.status, requestId: response.headers["x-github-request-id"] });
      return response;
    } catch (error) {
      operation.fail(error, { stage });
      throw error;
    }
  }

  async removeLabels(issueNumber: number, labels: string[], references: EventReferences = {}) {
    const { repository } = this;
    if (labels.length === 0) return [];
    const operation = startOperation("github.remove_labels", { ...references, repository, issueNumber, labels });
    const eventReferences = { ...references, operationId: operation.operationId };
    const responses = [];
    let stage = "authentication";
    let label: string | undefined;
    try {
      const { github, owner, repo } = await githubForRepository(repository, "write");
      for (label of labels) {
        stage = "request";
        let response: Awaited<ReturnType<typeof github.rest.issues.removeLabel>>;
        try {
          response = await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
          const { data } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
          if (data.labels.some((current) => (typeof current === "string" ? current : current.name)?.toLowerCase() === label!.toLowerCase())) throw error;
          continue;
        }
        responses.push(response);
        stage = "journal";
        recordEvent({ ...eventReferences, type: "github.label_removed", data: { repository, issueNumber, label } });
      }
      operation.complete({ removedLabels: responses.length });
      return responses;
    } catch (error) {
      operation.fail(error, { stage, label, removedLabels: responses.length });
      throw error;
    }
  }

  async createPullRequest(
    { title, body, head, base }: { title: string; body: string; head: string; base: string },
    references: EventReferences = {},
  ) {
    const { repository } = this;
    const operation = startOperation("github.create_pull_request", { ...references, repository, head, base });
    const eventReferences = { ...references, operationId: operation.operationId };
    let stage = "authentication";
    let pullRequestNumber: number | undefined;
    try {
      const { github, owner, repo } = await githubForRepository(repository, "pull_request");
      stage = "request";
      const response = await github.rest.pulls.create({ owner, repo, title, body, head, base, draft: false });
      pullRequestNumber = response.data.number;
      stage = "journal";
      recordEvent({ ...eventReferences, type: "github.pull_request_created", data: {
        repository, pullRequestNumber, url: response.data.html_url, head, base,
      } });
      operation.complete({ pullRequestNumber, status: response.status, requestId: response.headers["x-github-request-id"] });
      return pullRequestView(response.data);
    } catch (error) {
      operation.fail(error, { stage, pullRequestNumber });
      throw error;
    }
  }
}

export function githubRevision(item: { title: string; body?: string | null; head?: { sha: string }; base?: { ref: string } }, comments: GithubComment[]) {
  return createHash("sha256").update(JSON.stringify({
    title: item.title, body: item.body, head: item.head?.sha, base: item.base?.ref,
    comments: comments.map((comment) => `${comment.id}@${comment.revision}`).sort(),
  })).digest("hex");
}
