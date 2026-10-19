// Application-owned views. Existing stored API payloads remain structurally
// compatible; fresh responses are reduced to these fields at the adapter boundary.
export type GithubIssue = {
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  user?: { login: string } | null;
  labels: (string | { name?: string })[];
};

export type GithubPullRequest = GithubIssue & {
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
};

export type GithubItem = GithubIssue | GithubPullRequest;

export type GithubComment = {
  id: string;
  body: string;
  author?: string;
  revision: string;
  url: string;
  path?: string;
  line?: number | null;
};

export type GithubContext = { item: GithubItem; comments: GithubComment[] };
