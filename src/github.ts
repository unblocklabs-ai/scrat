import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { config } from "./config.ts";

export async function fetchOpenItems(repository: string) {
  const [owner, repo] = repository.split("/");
  const github = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      installationId: config.github.installationId,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      repositoryNames: [repo],
      permissions: { issues: "read", pull_requests: "read", metadata: "read" },
    },
  });

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
