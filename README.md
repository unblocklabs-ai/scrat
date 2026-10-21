# Scrat

Scrat is a GitHub coding agent built with TypeScript, [Pi](https://github.com/earendil-works/pi), and SQLite. It reviews issues and pull requests, implements selected issues, and maintains its own PRs. Scrat handles scheduling, workspaces, validation, and publication; Pi investigates and writes code.

## How it works

GitHub sync turns repository state into a persistent task queue:

- **PR reviews:** two model sessions review independently. A fresh consolidation session combines their findings into one updatable comment and a grade label. This includes Scrat's own PRs.
- **Implementation and maintenance:** issues labelled `scrat` become implementation tasks. Conflicts and new external feedback on Scrat-authored PRs become separate repair tasks.
- **Issue reviews:** Scrat assesses issues and applies the `scrat` label when it considers them ready for implementation.

Concurrency, priorities, models, and reasoning levels come from configuration. Queued tasks coalesce by item and action; tasks sharing an item or workspace cannot execute together. Bot-authored comments do not trigger feedback tasks. A current review graded C, D or F on a Scrat PR queues one `address_review` repair per assessment (a queued repair is cancelled when its assessment goes stale or human feedback is pending), capped per PR by `maxSelfRepairs`. An `address_review` or `address_pr_feedback` run whose agent changed nothing (same head, no merge in progress, clean tree) skips preparation and validation and publishes its reply directly.

Scrat serves the single configured repository and clone: sync and fetch refuse any other repository, a clone whose `origin` is a different repository is never updated (a clone whose origin is not a github.com URL for the configured repository, such as an ssh host alias, is refused), and queued tasks for items of another repository are rejected at claim.

GitHub access uses a repository-scoped client with shared, permission-specific authentication. Sync reads up to four issue discussions concurrently (issue metadata comes from the list response) and applies routing effects in order; each PR is observed once, inside its review lock, with its four reads in parallel, and that observation serves both routing and reconciliation. Startup sync still finishes before workers claim tasks. Credentials are cached; responses are revalidated, not trusted: reads send `If-None-Match` and GitHub's 304s (free against the rate limit) reuse the identical cached body, while publication and serialized PR reconciliation still fetch fresh state. When fewer than 10% of the hourly requests remain, sync defers its remaining item reads to the next interval (logged as `github.sync_deferred`, starting at a different item each sync); this also defers that PR's sync-driven reconciliation, but worker publication is never deferred. A rejected credential is refreshed on the next operation, without automatically replaying a failed write.

Implementations use isolated worktrees and branches; follow-ups reuse their workspace and Pi session. Checks must pass against the exact tree being committed before publication. Optional Docker PostgreSQL databases isolate mutating runs. PR closure triggers workspace cleanup; failed work is retained for recovery.

Stale branches are brought up to date by merge commit, never rebase. A Scrat PR that is behind its base and failed at preparation (or conflicts) gets a `resolve_conflicts` task: a clean merge is made in code without a model session and validated normally (a validation failure falls back to the agent in the same run), while conflicts go to the agent. Feedback and repair tasks on a behind Scrat PR whose preparation fails merge the base first and ship that merge with their own push. A human-authored PR that cannot be prepared because it is behind, but merges cleanly, is reviewed on a local throwaway merge of its base (the diff stays relative to the base, nothing is pushed or commented); if the merge conflicts, the review fails and asks the author to update the branch.

Repository commands, Git hooks and Pi's Bash receive a minimal inherited environment, never Scrat's credentials. Pi's file tools stay inside the worktree and its run's context directory (`data/runs/<run-id>/`, holding the discussion and larger context outside the worktree). Prompts are small manifests with no patch bodies; read-only sessions inspect changes through a capped, scope-recording read-only `git` tool instead of Bash. Comments, PR bodies and commits that contain configured credentials are refused rather than published.

The newest complete PR assessment is authoritative. Context and observed source/dependency changes determine freshness—a relevance heuristic, not a full dependency graph. Stale assessments lose their grade and require a fresh review; older opinions never regain authority. Publication-only retries reuse saved results. Scrat does not automatically merge PRs.

## Configure and run

Requires Node.js **22.19+**, Git, and the tools used by the target repository's workspace commands. Workspace commands and agents run on Scrat's Node, so the deployment uses the target repository's Node major (24 on the VM). Docker is required when per-run databases are configured.

1. Run `npm ci`.
2. Edit `scrat.config.json`: GitHub repository/App installation, model provider, action skills, concurrency, and workspace preparation/validation commands.
3. Create an untracked `.env` containing `CODEX_LB_API_KEY` and the GitHub credential for the chosen `github.auth` mode: `GITHUB_APP_PRIVATE_KEY` (default `"app"`; install the GitHub App on the target repository with the necessary contents, issues, and pull-request permissions) or `GITHUB_PAT` (`"pat"`; see GitHub authentication below). Add `SLACK_BOT_TOKEN` when `review_base_change` is enabled (see Slack bot below).
4. Initialize the local schema and start the service:

   ```sh
   npm run db:push
   npm run serve
   ```

**Starting the service enables real GitHub writes and code execution.** Use one service process; do not overlap it with standalone `sync` or `work` processes. On SIGTERM the service stops claiming tasks, and each running task stops at its next stage boundary (a running agent turn gets `harness.drainTimeoutSeconds` to finish, then is aborted) and is requeued to resume from its saved stage after the restart. A validation command already running is not interrupted.

Useful commands:

```sh
npm run fetch                    # Save GitHub state without routing tasks
npm run sync                     # Sync, queue tasks, and reconcile reviews/labels
npm run work                     # Drain runnable queued work, then exit
npm run retry -- <task-id>        # Repair a failed task, or resume publication
npm run retry -- <task-id> --validation-only  # Recheck saved code without Pi
npm run enqueue -- <action> <number|item-id>... [--priority N]  # Queue work for PR/issue numbers; sync never cancels it, even past routing guards (closing the item does)
npm run cleanup                  # Retry finished-run resource cleanup
npm run typecheck                # Strict TypeScript and Node type-erasure compatibility
npm run knip                     # Unused files, exports, and dependencies
npm test                         # Integration/E2E tests; PostgreSQL case needs Docker
```

When the final validation fails because a command exited nonzero (including preparation commands), the failure is sent back into the same Pi session, up to two rounds, before the run fails. Commands killed by a signal (an out-of-memory kill or a timeout), tree mutation, secret-scan and acceptance failures are not sent back and fail the run as before; use `--validation-only` for the infrastructure cases.

Change sessions are told to keep working notes in `.scrat/notes.md` inside their workspace, so plans and findings survive context compaction, retries and validation feedback. Scrat adds `/.scrat/` to the clone's shared Git exclude file, so the notes are never committed or published; they are removed with the workspace.

Normal retries rerun Pi for pre-publication failures, reusing the workspace/session so it can repair the problem. Publication-only retries reuse the saved validated result.

Use `--validation-only` for a transient validation failure after a mutating agent returned complete. It requires a saved checkpoint with unchanged task input, workspace identity, HEAD, source tree, merge state, GitHub context, and base SHA. Scrat skips Pi, creates a fresh disposable database when configured, reruns preparation/migrations and all checks, and still enforces action postconditions before publication. Ignored files are outside the source checkpoint; configured preparation must restore any required dependency/generated state. Changed or incomplete work requires a normal repair retry.

When upgrading an existing installation, run `npm run db:push` before starting the new code (the installer does this). Databases created before subjects existed are first moved with `node deploy/migrate-subjects.mjs [path]`, which the installer runs ahead of `db:push`; it is one transaction and a no-op on a migrated or fresh database. Old run history is preserved, but runs without checkpoints cannot use validation-only retry. No validation is bypassed, and a failed validation is retried only through the in-session feedback above.

For project review, run `typecheck`, `knip`, and the integration/E2E tests after `npm ci` (including dev dependencies). TypeScript checks `src/` and the Drizzle config without emitting JavaScript. Knip includes the CLI, deployment-only recovery, and subprocess-driven test entrypoints; ordinary source modules remain eligible for unused-code detection. Review findings before removing code or adding exceptions.

## Configuration

`scrat.config.json` controls runtime behavior (deployment overrides: see below). Restart the service after changing it; action settings are captured when a run is claimed, and retries retain their saved settings.

### Deployment overrides

`scrat.config.json` holds the defaults and ships with each release. Settings specific to one deployment go in `scrat.local.json`, a gitignored file next to it that holds only the overrides, for example `{"harness":{"maxConcurrency":8}}`. If it is missing, Scrat creates it containing `{}`.

- Plain objects merge recursively; arrays and primitives replace the default. `null` is accepted only under `workspace` (`"workspace":{"database":null}` disables the database).
- Every override key must exist in the defaults. An unknown key stops startup with a message such as `Unknown setting in scrat.local.json: harness.maxConcurency`, as does a non-object where the default is an object. `workspace.environment` (variable names) and `providers` are open: they accept keys the defaults do not show, so a provider can be overridden or added.
- Relative paths in overrides resolve from the config directory, like the defaults.
- On the VM the file lives at `~/.local/share/scrat-v2/scrat.local.json` and is linked into each release by the installer, which checks it before stopping the running service. After editing it, check it with `node src/config.ts` from `~/.local/share/scrat-v2/current`, then apply it with `systemctl --user restart scrat.service`, which waits for running tasks like a deploy.

### Harness and GitHub

| Setting | Purpose |
| --- | --- |
| `harness.maxConcurrency` | Maximum simultaneous tasks, not model sessions or test subprocesses. Each PR review starts two reviewer sessions within one task. Change-mode tasks run a database container and, at the end, the validation suite (bounded by `maxConcurrentValidations`), so size this to the host's memory. |
| `harness.commandTimeoutSeconds` | Longest a `workspace.prepare`, database migrate or `workspace.validate` command may run (default 3600, a positive integer). It is killed with SIGKILL and the run fails as infrastructure, eligible for validation-only retry, without re-prompting the agent. Clone, fetch and push are bounded separately at 600 seconds. |
| `harness.agentTimeoutSeconds` | Longest one agent turn may run (default 3600, a positive integer). The session is aborted and the run fails with `AGENT_TIMEOUT`. |
| `harness.drainTimeoutSeconds` | How long a running agent turn may continue after the service is told to stop (default 900, a positive integer). Other stages stop at their next boundary; an agent turn still running when this elapses is aborted. Either way the run is recorded as `RUN_INTERRUPTED` and its task is requeued to resume after the restart. |
| `harness.maxConcurrentValidations` | Maximum `workspace.validate` runs at once (default 3, a positive integer). Further runs wait in a FIFO queue; preparation does not take a slot. |
| `harness.logLevel` | Pino log verbosity, such as `info` or `debug`. |
| `github.repository` | Target GitHub repository as `owner/repo`. |
| `github.repositoryPath` | Local repository clone; relative paths resolve from the config directory. `SCRAT_REPOSITORY_PATH` overrides it. |
| `github.baseBranch` | Default base branch for issues and implementations. Existing PRs use their own base branch. |
| `github.auth` | `"app"` (default, GitHub App) or `"pat"` (classic personal access token). Startup requires the matching variable, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_PAT`; there is no automatic fallback between modes. |
| `github.botLogin` | The agent's GitHub login, used to recognize its PRs/comments and exclude its own feedback (compared case-insensitively). `scrat-unblock[bot]` for the App; the plain account login for a PAT. |
| `github.botName` | Display name the agent uses in prompts and generated text (default `Scrat`). Its lowercase slug (`Mocha Agent` becomes `mocha-agent`) is also the implementation-selection label and the prefix of new branches. |
| `github.appId` | GitHub App ID used for authentication (ignored in PAT mode). |
| `github.installationId` | App installation granting access to the target repository (ignored in PAT mode). |
| `github.fetchIntervalSeconds` | Delay between service syncs, in seconds. The service also syncs on startup. |

### GitHub authentication

Two modes are supported; `github.auth` picks one.

- **App (default).** A GitHub App installation token, minted per repository and per permission set. Nothing changes for existing deployments.
- **PAT.** A classic personal access token from a dedicated account that has write access to the repository (an outside collaborator is enough). Put `GITHUB_PAT=ghp_...` in `.env`; `GITHUB_APP_PRIVATE_KEY`, `appId` and `installationId` are not used.

Example `scrat.local.json` for a PAT deployment (every key already exists in the defaults, so the override loader accepts it):

```json
{
  "github": { "repository": "acme/widgets", "auth": "pat", "botLogin": "mocha-agent", "botName": "Mocha" },
  "actions": { "address_review": { "exhaustedLabel": "Mocha repair exhausted" } }
}
```

For the App, set `github.botLogin` to the bot login (`name[bot]`) and leave `auth` at its default.

PAT notes:

- Scopes: classic `repo` for a private repository (`public_repo` suffices for a public one), plus `workflow` only if the agent may change workflow files. Nothing administrative.
- A PAT is account-wide, unlike an App token that is scoped to the repository. Scrat enforces `github.repository` itself (sync, fetch, claims, and every GitHub client), but the token can do more than Scrat asks of it. Use a dedicated account: comments authored by `botLogin` are treated as the agent's own, so a human sharing the account would have their feedback ignored.
- On first use Scrat calls `GET /user` and refuses to run when the token's login differs from `github.botLogin` (case-insensitively); this prevents the agent from answering its own comments.
- Expiry and rotation: a classic PAT has the expiry you chose and stops working then. A 401 fails with `GitHub rejected GITHUB_PAT (401)`; replace the token in `.env` and restart the service.
- Organizations that enforce SAML SSO need the token authorized for the organization, and organizations may restrict classic PATs by policy; either shows up as a 401 or 403.
- `GITHUB_PAT` and the base64 `x-access-token:<PAT>` Git header are registered as secrets: they are redacted from logs and errors, refused in published content, and never inherited by workspace commands, hooks or the agent's Bash.

Renaming the bot: the label (`github.botName` slug) and branch prefix apply to new work. Issues labelled with the old name stop being selected, existing branches and PRs keep their names, `actions.address_review.exhaustedLabel` is a separate setting, and a resumed Pi session keeps the old name in its history. Relabel open issues when renaming.

Before relying on a new deployment, run it once against a disposable repository (the integration suite uses a fake GitHub and cannot prove these):

1. `npm run fetch` succeeds and its first PAT call logs no 401/403.
2. A labelled issue becomes a PR: the branch pushes over HTTPS with the Git header, the PR and its comment are authored by `botLogin`.
3. A comment from another account on that PR queues `address_pr_feedback`; the agent's own comment does not queue anything.
4. The selection label is added and removed on a reviewed issue.
5. With an SSO organization, the token works only after SSO authorization.
6. Expire or revoke the token and confirm the `GITHUB_PAT` 401 message.

### Workspace

Workspace commands are argument arrays, not shell strings: `["pnpm", "verify"]`. Command lists execute sequentially inside the worktree; a failing command stops the run.

| Setting | Purpose |
| --- | --- |
| `workspace.environment` | Environment variables added to Pi's Bash commands and harness preparation/validation commands. These commands inherit only path, home, user, locale, temporary-directory, proxy, certificate and `DOCKER_HOST` settings, so any other variable they need belongs here. Test-process limits belong here too; task concurrency does not serialize tests. |
| `workspace.prepare` | Setup commands, including dependency installation and code generation. Also used for read-only reviews, and rerun before mutating-work validation. |
| `workspace.heavyCommands` | Optional regular expressions, matched against each shell command segment of Pi's Bash tool, with quoted text ignored and whitespace collapsed (leading `VAR=value`, `env`, `nohup`, `time`, `sudo`, `exec` and `timeout N` are stripped). A foreground match is queued, not refused: it runs in one of the `harness.maxConcurrentValidations` slots, shared with Scrat's own validation, and logs `pi.heavy_command` with its wait. It may hold the slot for at most 45 minutes, and a cancelled run leaves the queue. A command that backgrounds work (a background `&`, `nohup`, `setsid` or `disown`) is refused instead, because the job would outlive its slot; the agent is told to run it in the foreground. This is a speed bump against accidental parallel lint/type-check/verify runs, not a sandbox: `sh -c '...'` or a script can still evade it. |
| `workspace.validate` | Required checks for mutating tasks before committing or publishing. Not run as a harness gate for read-only reviews. |
| `workspace.database` | Optional per-run PostgreSQL container configuration for mutating tasks; omit or set to `null` to disable. |
| `workspace.database.image` | PostgreSQL-compatible Docker image to start. |
| `workspace.database.environment` | Variable names populated with the temporary database URL, overriding corresponding workspace environment values. |
| `workspace.database.migrate` | Migration command run against the temporary database before validation. |

### Model providers

Each `providers.<name>` entry registers an endpoint and models with Pi. Actions refer to the provider by that name.

| Setting | Purpose |
| --- | --- |
| `baseUrl` | Provider or proxy API endpoint. |
| `api` | Pi API adapter, such as `openai-responses`. |
| `apiKey` | Credential; use environment interpolation such as `${CODEX_LB_API_KEY}` rather than committing a secret. |
| `authHeader` | Whether Pi supplies the API key in the Authorization header. |
| `models` | Models available through this provider. |
| `models[].id` / `name` | API model identifier / optional display name. Actions select the identifier. |
| `models[].reasoning` | Whether the model supports reasoning. |
| `models[].thinkingLevelMap` | Optional mapping from Pi thinking levels to provider-specific reasoning values. |
| `models[].contextWindow` | Declared context capacity in tokens. |
| `models[].maxTokens` | Model output-token limit used by Pi. |

### Actions

Each action is one manifest, `actions/<name>.yaml`, validated at startup (`src/manifests.ts`): `review_issue`, `review_pr`, `implement`, `resolve_conflicts`, `address_pr_feedback`, `address_review`, and `review_base_change`. A manifest fixes the trigger, mode, acceptance rule, `tools` the agent session gets, context `files`, and publish effects, all from closed lists; an unknown key or value stops startup with the file and path. `scrat.config.json` no longer has an `actions` block: the settings below are the manifest's deployment-level keys, and `scrat.local.json` overrides them by action name.

| Setting under `actions.<action>` | Purpose |
| --- | --- |
| `priority` | Default queue priority; higher values are claimed first. Manual enqueue can override it. Running tasks are not preempted. |
| `skill` | Prompt file, resolved relative to the config directory. |
| `provider` / `model` | Provider name and model ID for the action. For PR reviews, these select the consolidator. |
| `thinkingLevel` | Requested Pi reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; provider/model support determines its mapping. |
| `reviewers` | PR review panel: exactly two entries, each with its own `provider`, `model`, and `thinkingLevel`. |
| `maxSelfRepairs` | `address_review` only: most self-repair runs started for one PR (non-negative integer, default 2; 0 disables self-repair; not enqueueable manually). A push makes the review stale and Scrat re-reviews; a reply-only repair is not retriggered for the same assessment. |
| `exhaustedLabel` | `address_review` only, optional: label added to a Scrat PR whose current review is graded C or lower once `maxSelfRepairs` is reached, and removed when its current review grades better. `null` or `""` (e.g. in `scrat.local.json`) disables it; GitHub creates the label if it is missing. A repair counts toward `maxSelfRepairs` when it starts running, not when it is queued or cancelled. |

The checked-in configuration currently uses six task slots and three validation slots (sized for a 24 GB host, with the service capped at `MemoryMax=20G`), priorities **PR 100 > implementation/maintenance 60 > issue 10**, and a Sol-high/DeepSeek-high review panel with Sol-high consolidation. These are configurable values, not built-in limits or model choices.

### Optional actions

An action runs unless its `enabled` is `false`. Only `review_base_change` ships with `enabled: false` (in `actions/review_base_change.yaml`); a deployment turns it on in `scrat.local.json`:

```json
{ "actions": { "review_base_change": { "enabled": true, "channel": "C0123456789" } } }
```

Disabling an action stops its queued tasks from being claimed. For a disabled action, startup skips the skill file check and the settings checks.

### Base branch review

`review_base_change` reviews each update to `github.baseBranch` and reports the review in Slack. It runs on the `github.fetchIntervalSeconds` interval, and at startup, and queues one review per push range: from the last seen tip to the new tip, not one per commit. Scrat's own merged commits are reviewed too; there is no author filter.

For each review, Scrat posts `startMessage` to the channel as the opening message, then replies in that thread with the review: at most two short paragraphs, and at most 3,000 characters.

The agent receives the commit messages, the changed paths and the diff for the range. It has read-only tools, including `read_base` for the commit before the range. It does not install dependencies, run validation, open a PR or post to Slack, and it never sees the Slack token.

| Setting under `actions.review_base_change` | Purpose |
| --- | --- |
| `enabled` | `false` by default. Set `true` in `scrat.local.json` to turn the action on. |
| `agent` | `single` (default) runs one review session. `panel` runs the two `reviewers` as in PR review, and `provider` and `model` consolidate them into one reply. |
| `reviewers` | Empty by default. Required with exactly two entries when `agent` is `panel`; each takes `provider`, `model` and `thinkingLevel`. |
| `branch` | Must equal `github.baseBranch`; checked at startup. |
| `channel` | Slack channel ID to post in. Required when enabled, and the bot must be a member of it. |
| `maxRangeCommits` | Default 50. A range with more first-parent commits is recorded on its task as `truncated`. The review still covers the whole range. |
| `startMessage` | Opening message template. Variables: `{{sha}}` (tip commit), `{{short_sha}}`, `{{author}}` (commit author name), `{{title}}` (commit subject), `{{url}}`, `{{branch}}`, `{{count}}` (commits in the range) and `{{bot}}` (`github.botName`). Any other `{{name}}` stops startup. |
| `priority`, `skill`, `provider`, `model`, `thinkingLevel` | As in the table above. Priority defaults to 30, below implementation and maintenance tasks. |

Author and title are escaped for Slack. Messages do not unfurl links or ping users by name.

On the first run after enabling, Scrat records the current tip and reviews nothing. Disabling deletes that record, so enabling again starts from the new tip and does not review the commits pushed while the action was off.

If the recorded tip is no longer an ancestor of the new tip (a force-push), Scrat reviews from the merge base of the two when the old tip is still in the clone. A new tip behind the recorded one, or one with no merge base, starts again from the new tip without a review. These cases are logged as `commits.cursor_rewound` and `commits.cursor_reset`.

Failures:

- Slack is unreachable when the run starts: Scrat logs `slack.post_failed` and runs the review anyway. The opening message is posted with the reply.
- Slack is unreachable when the reply is posted: the run fails at publishing. `npm run retry -- <task-id>` reuses the saved review and posts only the reply to the thread, without running the agent again.
- Slack has no idempotency key. A crash after Slack accepts a message but before Scrat records its timestamp can post that message again on retry, either the opening message or the reply.

### Slack bot

`review_base_change` posts through a Slack bot:

1. Create a Slack app in the workspace, from scratch.
2. Under OAuth & Permissions, add the bot token scope `chat:write`, then install the app to the workspace.
3. Copy the Bot User OAuth Token (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN=xoxb-...`.
4. Invite the bot to the channel (`/invite @<bot name>`) and set `actions.review_base_change.channel` to the channel's ID.

When the action is enabled, startup calls Slack's `auth.test` with the token, and a failure stops startup. The token comes only from the environment, never from `scrat.config.json`. Scrat redacts it from logs and errors, refuses to publish text that contains it, and does not pass it to agents or workspace commands.

## Project layout

- `src/github-tasks.ts` — GitHub observations, queue effects, and closure cleanup.
- `src/github.ts`, `src/github-types.ts` — repository client, scoped authentication, and narrow issue/PR views; the newest 48 raw sync snapshots per repository remain in SQLite, and the latest in `tmp/responses/github/`, for diagnostics.
- `src/github-context.ts` — pure shared comment filtering and context revisions for routing, execution, and freshness checks.
- `src/manifests.ts`, `src/actions.ts` — the manifest schema and loader, and the registry of loaded actions; workspace lifetime follows action mode.
- `src/github-routing.ts` — pure issue-selection, PR-maintenance, and review-routing decisions.
- `src/tasks.ts`, `src/runner.ts` — atomic claims and task/run lifecycle.
- `src/pi.ts`, `src/pr-review.ts` — Pi sessions and dual-model reviews.
- `src/pr-assessment.ts`, `src/pr-review-publication.ts` — assessment authority, freshness, and canonical delivery.
- `src/workspaces.ts`, `src/databases.ts` — Git and database resource lifecycles.
- `src/secrets.ts` — child-process environment and credential checks before publication.
- `actions/` — one YAML manifest per action; `skills/` — action prompts.
- `data/` — SQLite queue, run history, event journal, workspaces, and Pi sessions. Back it up alongside credentials before deployment.

`deploy/install.sh` installs a staged release on the existing worker: it drains the service, backs up SQLite, applies schema updates, and switches to the selected release. It contains host-specific paths, so review it before reuse.
