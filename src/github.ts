import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type { Logger } from "pino";
import { config } from "./config.ts";
import { recordEvent, type EventReferences, type JournalEvent } from "./events.ts";
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

function recordPublishedEvent(event: JournalEvent, log: Logger) {
  try {
    recordEvent(event);
  } catch (err) {
    log.error({ event: "journal.failed", journalEventType: event.type, remoteSucceeded: true, err }, "Journal write failed");
    throw err;
  }
}

export async function postComment(repository: string, issueNumber: number, body: string, references: EventReferences = {}) {
  const operation = startOperation("github.post_comment", { ...references, repository, issueNumber });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  const response = await githubForRepository(repository, "write", operation.log)
    .then(({ github, owner, repo }) => {
      stage = "request";
      return github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    })
    .catch((error: unknown) => {
      operation.fail(error, { stage });
      throw error;
    });
  operation.complete({ stage: "remote_write", commentId: response.data.id, status: response.status, requestId: response.headers["x-github-request-id"] });
  recordPublishedEvent({ ...eventReferences, type: "github.comment_created", data: {
    repository, issueNumber, commentId: response.data.id, url: response.data.html_url,
  } }, operation.log);
  return response;
}

export async function updateComment(repository: string, commentId: number, body: string, references: EventReferences = {}) {
  const operation = startOperation("github.update_comment", { ...references, repository, commentId });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  const response = await githubForRepository(repository, "write", operation.log)
    .then(({ github, owner, repo }) => {
      stage = "request";
      return github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    })
    .catch((error: unknown) => {
      operation.fail(error, { stage });
      throw error;
    });
  operation.complete({ stage: "remote_write", commentId: response.data.id, status: response.status, requestId: response.headers["x-github-request-id"] });
  recordPublishedEvent({ ...eventReferences, type: "github.comment_updated", data: {
    repository, commentId: response.data.id, url: response.data.html_url,
  } }, operation.log);
  return response;
}

export async function addLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  const operation = startOperation("github.add_labels", { ...references, repository, issueNumber, labels });
  const eventReferences = { ...references, operationId: operation.operationId };
  let stage = "authentication";
  const response = await githubForRepository(repository, "write", operation.log)
    .then(({ github, owner, repo }) => {
      stage = "request";
      return github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    })
    .catch((error: unknown) => {
      operation.fail(error, { stage });
      throw error;
    });
  operation.complete({ stage: "remote_write", status: response.status, requestId: response.headers["x-github-request-id"] });
  recordPublishedEvent({ ...eventReferences, type: "github.labels_added", data: { repository, issueNumber, labels } }, operation.log);
  return response;
}

export async function removeLabels(repository: string, issueNumber: number, labels: string[], references: EventReferences = {}) {
  if (labels.length === 0) return [];
  const clientOperation = startOperation("github.remove_labels", { ...references, repository, issueNumber, labels });
  const eventReferences = { ...references, operationId: clientOperation.operationId };
  const client = githubForRepository(repository, "write", clientOperation.log);
  const responses = [];
  let stage = "authentication";
  for (const label of labels) {
    const response = await client
      .then(({ github, owner, repo }) => {
        stage = "request";
        return github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
      })
      .catch((error: unknown) => {
        clientOperation.fail(error, { stage, label, removedLabels: responses.length });
        throw error;
      });
    clientOperation.log.info({ event: "github.label_removed", stage: "remote_write", label, status: response.status, requestId: response.headers["x-github-request-id"] });
    recordPublishedEvent({ ...eventReferences, type: "github.label_removed", data: { repository, issueNumber, label } }, clientOperation.log);
    responses.push(response);
  }
  clientOperation.complete({ removedLabels: responses.length });
  return responses;
}
