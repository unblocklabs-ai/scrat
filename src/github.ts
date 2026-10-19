import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type { Logger } from "pino";
import { config } from "./config.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { logger, startOperation } from "./logging.ts";

async function githubForRepository(repository: string, access: "read" | "write", log: Logger) {
  const [owner, repo] = repository.split("/");
  const authenticate = createAppAuth({
    appId: config.github.appId,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    log: log.child({ component: "github.auth" }),
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
    log: log.child({ component: "octokit" }),
    ...(access === "write" ? { retry: { enabled: false }, throttle: { enabled: false } } : {}),
  });
  return { github, owner, repo };
}

export async function fetchOpenItems(repository: string, log: Logger = logger) {
  const { github, owner, repo } = await githubForRepository(repository, "read", log);
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
  const operation = startOperation("github.post_comment", { ...references, repository, issueNumber });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  let commentId: number | undefined;
  try {
    const { github, owner, repo } = await githubForRepository(repository, "write", operation.log);
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
    operation.fail(error, { stage, remoteSucceeded: stage === "journal" ? true : undefined, commentId });
    throw error;
  }
}

export async function updateComment(repository: string, commentId: number, body: string, references: EventReferences = {}) {
  const operation = startOperation("github.update_comment", { ...references, repository, commentId });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  try {
    const { github, owner, repo } = await githubForRepository(repository, "write", operation.log);
    stage = "request";
    const response = await github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    stage = "journal";
    recordEvent({ ...eventReferences, type: "github.comment_updated", data: {
      repository, commentId: response.data.id, url: response.data.html_url,
    } });
    operation.complete({ commentId: response.data.id, status: response.status, requestId: response.headers["x-github-request-id"] });
    return response;
  } catch (error) {
    operation.fail(error, { stage, remoteSucceeded: stage === "journal" ? true : undefined });
    throw error;
  }
}

export async function addLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  const operation = startOperation("github.add_labels", { ...references, repository, issueNumber, labels });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  try {
    const { github, owner, repo } = await githubForRepository(repository, "write", operation.log);
    stage = "request";
    const response = await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    stage = "journal";
    recordEvent({ ...eventReferences, type: "github.labels_added", data: { repository, issueNumber, labels } });
    operation.complete({ status: response.status, requestId: response.headers["x-github-request-id"] });
    return response;
  } catch (error) {
    operation.fail(error, { stage, remoteSucceeded: stage === "journal" ? true : undefined });
    throw error;
  }
}

export async function removeLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  if (labels.length === 0) return [];
  const operation = startOperation("github.remove_labels", { ...references, repository, issueNumber, labels });
  const eventReferences = { ...references, operationId: operation.operationId };
  const responses = [];
  let stage = "authentication";
  let label: string | undefined;
  try {
    const { github, owner, repo } = await githubForRepository(repository, "write", operation.log);
    for (label of labels) {
      stage = "request";
      const response = await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
      responses.push(response);
      stage = "journal";
      recordEvent({ ...eventReferences, type: "github.label_removed", data: { repository, issueNumber, label } });
    }
    operation.complete({ removedLabels: responses.length });
    return responses;
  } catch (error) {
    operation.fail(error, { stage, remoteSucceeded: stage === "journal" ? true : undefined, label, removedLabels: responses.length });
    throw error;
  }
}
