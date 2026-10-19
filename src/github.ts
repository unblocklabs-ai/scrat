import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { config } from "./config.ts";
import { describeError } from "./errors.ts";
import { recordEvent, type EventReferences } from "./events.ts";

async function githubForRepository(repository: string, access: "read" | "write") {
  const [owner, repo] = repository.split("/");
  const authenticate = createAppAuth({
    appId: config.github.appId,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
  });
  const { token } = await authenticate({
    type: "installation",
    installationId: config.github.installationId,
    repositoryNames: [repo],
    permissions: access === "read"
      ? { issues: "read", pull_requests: "read", metadata: "read" }
      : { issues: "write", metadata: "read" },
  });
  const github = new Octokit({
    auth: token,
    ...(access === "write" ? { retry: { enabled: false }, throttle: { enabled: false } } : {}),
  });
  return { github, owner, repo };
}

export async function fetchOpenItems(repository: string) {
  const { github, owner, repo } = await githubForRepository(repository, "read");
  const items = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: "open", per_page: 100,
  });
  const pullRequests = items.some((item) => item.pull_request)
    ? await github.paginate(github.rest.pulls.list, {
        owner, repo, state: "open", per_page: 100,
      })
    : [];

  return { items, pullRequests };
}

export async function postComment(repository: string, issueNumber: number, body: string, references: EventReferences = {}) {
  const response = await githubForRepository(repository, "write")
    .then(({ github, owner, repo }) => github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body }))
    .catch((error: unknown) => {
      recordEvent({ ...references, type: "github.write_failed", data: {
        repository, operation: "postComment", issueNumber, error: describeError(error),
      } });
      throw error;
    });
  recordEvent({ ...references, type: "github.comment_created", data: {
    repository, issueNumber, commentId: response.data.id, url: response.data.html_url,
  } });
  return response;
}

export async function updateComment(repository: string, commentId: number, body: string, references: EventReferences = {}) {
  const response = await githubForRepository(repository, "write")
    .then(({ github, owner, repo }) => github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body }))
    .catch((error: unknown) => {
      recordEvent({ ...references, type: "github.write_failed", data: {
        repository, operation: "updateComment", commentId, error: describeError(error),
      } });
      throw error;
    });
  recordEvent({ ...references, type: "github.comment_updated", data: {
    repository, commentId: response.data.id, url: response.data.html_url,
  } });
  return response;
}

export async function addLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  const response = await githubForRepository(repository, "write")
    .then(({ github, owner, repo }) => github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels }))
    .catch((error: unknown) => {
      recordEvent({ ...references, type: "github.write_failed", data: {
        repository, operation: "addLabels", issueNumber, labels, error: describeError(error),
      } });
      throw error;
    });
  recordEvent({ ...references, type: "github.labels_added", data: { repository, issueNumber, labels } });
  return response;
}

export async function removeLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  if (labels.length === 0) return [];
  const client = githubForRepository(repository, "write");
  const responses = [];
  for (const label of labels) {
    const response = await client
      .then(({ github, owner, repo }) => github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label }))
      .catch((error: unknown) => {
        recordEvent({ ...references, type: "github.write_failed", data: {
          repository, operation: "removeLabels", issueNumber, labels: [label], error: describeError(error),
        } });
        throw error;
      });
    recordEvent({ ...references, type: "github.label_removed", data: { repository, issueNumber, label } });
    responses.push(response);
  }
  return responses;
}
