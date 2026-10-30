# Scrat

Scrat is a GitHub coding agent built with TypeScript, [Pi](https://github.com/earendil-works/pi), and SQLite. It reviews issues and pull requests, implements selected issues, and maintains its own PRs. Scrat handles scheduling, workspaces, validation, and publication; Pi investigates and writes code.

## How it works

GitHub sync turns repository state into a persistent task queue:

- **PR reviews:** by default two model sessions review independently. A fresh consolidation session combines their findings into one updatable comment and a grade label. This includes Scrat's own PRs.
  A re-review caused only by relevant changes on the base branch, with the PR head and discussion unchanged since the authoritative assessment and no manual request, runs one session with the first configured reviewer and no consolidation. That plan is rechecked against the observed state before inference and falls back to the full panel if it no longer holds; the run's `reviewers` and model fields record which plan ran.
- **Implementation and maintenance:** issues labelled `scrat` become implementation tasks. Conflicts and new external feedback on Scrat-authored PRs become separate repair tasks.
- **Issue reviews:** Scrat assesses issues and applies the `scrat` label when it considers them ready for implementation; it never removes the label, so a selection stays a human's to undo. Each issue has one assessment comment, which later reviews edit in place; a re-review gets the previous assessment, and one whose text and readiness are unchanged writes nothing to GitHub.

Concurrency, priorities, models, and reasoning levels come from configuration. Queued tasks coalesce by item and action; tasks sharing an item or workspace cannot execute together. Bot-authored comments do not trigger feedback tasks. A current review graded C, D or F on a Scrat PR queues one `address_review` repair per assessment (a queued repair is cancelled when its assessment goes stale or human feedback is pending), capped per PR by `maxSelfRepairs`. An `address_review` or `address_pr_feedback` run whose agent changed nothing (same head, no merge in progress, clean tree) skips preparation and validation and publishes its reply directly.

Scrat serves the single configured repository and clone: sync and fetch refuse any other repository, a clone whose `origin` is a different repository is never updated (a clone whose origin is not a github.com URL for the configured repository, such as an ssh host alias, is refused), and queued tasks for items of another repository are rejected at claim.

Implementations use private clones and branches; follow-ups reuse their workspace and Pi session. Checks must pass against the exact tree being committed before publication. Optional Docker PostgreSQL databases isolate mutating runs. PR closure triggers workspace cleanup; failed work is retained for recovery.

Stale branches are brought up to date by merge commit, never rebase. A Scrat PR that is behind its base and failed at preparation (or conflicts) gets a `resolve_conflicts` task: a clean merge is made in code without a model session and validated normally (a validation failure falls back to the agent in the same run), while conflicts go to the agent. Feedback and repair tasks on a behind Scrat PR whose preparation fails merge the base first and ship that merge with their own push. Otherwise a repair or feedback agent whose verified fix needs code that is only on the base merges it uncommitted, and Scrat commits that merge with the fix. A human-authored PR that cannot be prepared because it is behind, but merges cleanly, is reviewed on a local throwaway merge of its base (the diff stays relative to the base, nothing is pushed or commented); if the merge conflicts, the review fails, Scrat replaces its assessment comment with a note asking the author to update the branch, and that PR is not reviewed again until its head, its base branch or the base branch's tip changes, or a review is enqueued by hand.

Repository commands, Git hooks and Pi's Bash receive a minimal inherited environment, never Scrat's credentials. Pi's file tools stay inside the workspace and its run's context directory (`data/runs/<run-id>/`, holding the discussion and larger context outside the worktree). Prompts are small manifests with no patch bodies; read-only sessions inspect changes through a capped, scope-recording read-only `git` tool instead of Bash. Comments, PR bodies and commits that contain configured credentials are refused rather than published.

The newest complete PR assessment is authoritative. Context and observed source/dependency changes determine freshness—a relevance heuristic, not a full dependency graph. A re-review's scope keeps the earlier scope and the item's own files, but files it looked at only because the base branch changed them do not join it. Stale assessments lose their grade and require a fresh review; older opinions never regain authority. Publication-only retries reuse saved results. Scrat does not automatically merge PRs.

## Configure and run

Requires Node.js **22.19+**, Git, and the tools used by the target repository's workspace commands. Workspace commands and agents run on Scrat's Node, so the deployment uses the target repository's Node major (24 on the VM). Docker is required when per-run databases are configured.

1. Run `npm ci`.
2. Edit `scrat.config.json`: GitHub repository/App installation, model provider, action skills, concurrency, and workspace preparation/validation commands.
3. Create an untracked `.env` containing `CODEX_LB_API_KEY` and the GitHub credential for the chosen `github.auth` mode: `GITHUB_APP_PRIVATE_KEY` (`"app"`; install the GitHub App on the target repository with the necessary contents, issues, pull-request, and checks (read) permissions, plus deployments (write) for storefront previews) or `GITHUB_PAT` (`"pat"`; see GitHub authentication below). Add `SLACK_BOT_TOKEN` when `review_base_change` is enabled (see Slack status below), and `LOGGIE_API_KEY` when storefront previews are enabled (see Storefront previews below).
4. Initialize the local schema and start the service:

   ```sh
   npm run db:push
   npm run serve
   ```

**Starting the service enables real GitHub writes and code execution.** Use one service process; do not overlap it with standalone `sync` or `work` processes. On SIGTERM the service stops claiming tasks, and each running task stops at its next stage boundary (a running agent turn gets `harness.drainTimeoutSeconds` to finish, then is aborted) and is requeued to resume from its saved stage after the restart: a run stopped at publication resumes there, a change stopped at validation resumes with its saved checkpoint, and a review stopped after its agent finished resumes at validating with its stored assessment and runs only the storefront checks and publication (the read-only review workspace is recreated at the reviewed commit; the agent is not prompted again). A run stopped during the agent stage starts over with a new session; resuming the session itself is the remaining scope of #214. Startup crash recovery requeues unfinished runs the same way instead of leaving them failed, and journals `run.recovered` with `requeued: true`; a resumed run journals `run.resumed` with its `stage`, `fromRunId` and `reason` (`drain`, `crash` or `retry`). A validation command already running is not interrupted.

Useful commands:

```sh
npm run fetch                    # Save GitHub state without routing tasks
npm run sync                     # Sync, queue tasks, and reconcile reviews/labels
npm run work                     # Drain runnable queued work, then exit
npm run retry -- <task-id>        # Repair a failed task, or resume publication
npm run retry -- <task-id> --validation-only  # Recheck saved code without a new agent turn
npm run enqueue -- <action> <number|item-id>... [--priority N]  # Queue work for PR/issue numbers; sync never cancels it, even past routing guards (closing the item does)
npm run cleanup                  # Retry finished-run resource cleanup
npm run typecheck                # Strict TypeScript and Node type-erasure compatibility
npm run knip                     # Unused files, exports, and dependencies
npm test                         # Integration/E2E tests, 4 scenarios at a time (SCRAT_TEST_CONCURRENCY=N to change), about 2 minutes; PostgreSQL case needs Docker
```

When the final validation fails because a command exited nonzero (including preparation commands), the failure is sent back into the same Pi session, up to `harness.corrections.validation` rounds, before the run fails. This includes a run resumed at validation after a restart and a `--validation-only` retry. Commands killed by a signal (an out-of-memory kill or a timeout), tree mutation, secret-scan and acceptance failures are not sent back and fail the run as before; use `--validation-only` for the infrastructure cases.

Change sessions are told to keep working notes in `.scrat/notes.md` inside their workspace, so plans and findings survive context compaction, retries and validation feedback. Scrat adds `/.scrat/` to the clone's shared Git exclude file, so the notes are never committed or published; they are removed with the workspace.

Normal retries rerun Pi for pre-publication failures, reusing the workspace/session so it can repair the problem. Publication-only retries reuse the saved validated result.

Use `--validation-only` for a transient validation failure after a mutating agent returned complete. It requires a saved checkpoint with unchanged task input, workspace identity, HEAD, source tree, merge state, GitHub context, and base SHA. Scrat skips the agent's turn, creates a fresh disposable database when configured, reruns preparation/migrations and all checks, and still enforces action postconditions before publication; a check that exits nonzero goes back into the saved session. Ignored files are outside the source checkpoint; configured preparation must restore any required dependency/generated state. Changed or incomplete work requires a normal repair retry.

## Install and update

A VM serves one repository. Scrat lives in its service user's `~/.local/share/scrat-v2` (`releases/<commit>/`, `current`, `data/`, `backups/`, `.env`, `scrat.local.json`, `deploy.json`) and is managed by `deploy/scrat`, a bash CLI that runs on the VM as that user. `scrat install` copies it to `~/.local/bin/scrat` and every update refreshes it. Add `--dry-run` to either command to print the script it would run instead of running it.

First install, on Ubuntu or Debian:

1. In `~/.local/share/scrat-v2`, write `.env` (secrets only, see Configure and run), `scrat.local.json` (the repository's settings, see Deployment overrides) and `deploy.json`, for example:

   ```json
   { "unit": "user", "repositoryPath": "/home/scrat/.local/share/scrat-v2/repository", "packageManager": "pnpm@11.7.0", "keepReleases": 3, "memoryMax": "20G", "docker": true }
   ```

2. Fetch the CLI from the latest release tag (`v<version>`) and run the installer, which asks for the sudo password when a host step is missing:

   ```sh
   mkdir -p ~/.local/bin && curl -fsSLo ~/.local/bin/scrat https://raw.githubusercontent.com/unblocklabs-ai/scrat/v<version>/deploy/scrat && chmod 755 ~/.local/bin/scrat
   ~/.local/bin/scrat install --node 24.22.1
   ```

3. Start the service with the command it prints.

`scrat install` uses sudo only for what is missing: apt packages (including `bubblewrap`), the AppArmor profiles `deploy/scrat-bwrap.apparmor` and `deploy/scrat-chromium.apparmor` (plus `deploy/scrat-rootlesskit.apparmor` with Docker) in `/etc/apparmor.d`, and linger. It installs `--node <version>` into `runtime/`, checked against nodejs.org's `SHASUMS256.txt`, and points `runtime/node` at it; without `--node` it keeps the existing `runtime/node`. It activates `packageManager` through Corepack, installs rootless Docker as the user unit `scrat-docker.service` when `docker` is true (`deploy/docker.sha256` pins the version and checksums; the user needs subordinate id ranges), and writes `scrat.service`. On a host without a release, it then installs the latest release as `scrat update` does. While the service is stopped, it fetches the repository's open issues and pull requests and prints how many there are, how many the bot login authored, and the enabled actions: the first sync reviews all of them. It marks the hosts it sets up with `.scrat-install`; running it again on one changes nothing, the release included, which only `scrat update` changes.

Hosts set up before the CLI (with `current` or a `scrat.service` or `scrat-docker.service` unit, but no `.scrat-install`) use `scrat update` only. `scrat install` refuses them; `scrat install --force` takes one over, rewriting its units from `deploy.json` and keeping its release.

Updates need no sudo for a user unit. From a laptop: `ssh <host> '~/.local/bin/scrat update v2.0.47'`; with no version it installs the latest GitHub release, and an older version downgrades the same way. It runs detached, so an ssh drop does not stop it, streams its log, and keeps it in `~/.local/share/scrat-v2/update.log`, whose last line is `Deployed <commit>`. Each run overwrites the log; a run refused because another is still going leaves it alone. Reattach with `tail -n +1 -f ~/.local/share/scrat-v2/update.log`. Running it for the deployed release changes nothing. Downloads give up after 30 seconds without a connection or 60 seconds below 1 KB/s.

1. It downloads the tag's tarball from GitHub, takes the commit from the tarball's header, extracts it into `releases/<commit>/`, and refuses it unless `package.json` has the tag's version.
2. While the old release keeps running, it runs `npm ci`, prepares the search tools, links `data`, `.env` and `scrat.local.json`, checks the config and the sandbox, and rehearses the schema push on a copy of the database, which must converge and pass `pragma integrity_check`. A failure here leaves the running service and everything it uses untouched.
3. It stops the service, backs up the unit and its drop-ins, `.env`, `scrat.local.json`, `deploy.json`, the wrapper and the database into `backups/<time>/`, pushes the schema, switches `current`, starts the service again if it was running, and refreshes `~/.local/bin/scrat`. If a step fails after the stop and before the schema push, it starts the old release again. If one fails later, it leaves the service stopped and prints the command that starts it.
4. It removes releases beyond `keepReleases` and prints the space freed. Backups are not pruned.

| `deploy.json` key | Purpose |
| --- | --- |
| `unit` | `"user"`: `scrat.service` is a systemd user unit. `"system"`: a system unit with `User=` set to the service user; `scrat update` then runs `sudo systemctl`, which must not prompt. |
| `repositoryPath` | Absolute path of the target repository's clone, passed to the service as `SCRAT_REPOSITORY_PATH`. Scrat clones it on the first sync. `scrat update` passes it to the sandbox preflight, so on a host set up before the CLI it must be the `SCRAT_REPOSITORY_PATH` of the live unit or wrapper. |
| `packageManager` | `"pnpm@<version>"` (the target repository's `packageManager` field), activated through Corepack with its shims in `bin/`, or `"npm"`, for which the sandbox preflight checks `npm` instead of `pnpm`. |
| `keepReleases` | Releases kept after an update, newest first. The current and previous releases are always kept. |
| `memoryMax` | Optional `MemoryMax=` of the unit that `scrat install` writes, as a string such as `"20G"`. |
| `wrapper` | Optional absolute path of a program the unit runs instead of `node src/recover-active.ts && node src/serve.ts`, for example to load secrets kept elsewhere; it must exec both. Each update backs it up. |
| `docker` | Optional. `true` installs rootless Docker for per-run databases; needs `"unit": "user"`. |

`scrat update` uses `runtime/node/bin/node`, or `node` on `PATH` when that link does not exist, and never rewrites the unit: rerun `scrat install` (or edit the unit by hand) after changing `deploy.json` keys that shape it.

## Configuration

`scrat.config.json` controls runtime behavior (deployment overrides: see below). Restart the service after changing it; action settings are captured when a run is claimed, and retries retain their saved settings.

### Deployment overrides

`scrat.config.json` holds the defaults and ships with each release. Settings specific to one deployment go in `scrat.local.json`, a gitignored file next to it that holds only the overrides, for example `{"harness":{"maxConcurrency":8}}`. If it is missing, Scrat creates it containing `{}`.

- Plain objects merge recursively; arrays and primitives replace the default. `null` is accepted only where the schema allows it: `workspace.database` (`"workspace":{"database":null}` disables the database), `workspace.commandMemoryMax`, `workspace.packageStore`, and an action's `exhaustedLabel` or `failedLabel`.
- The merged config is validated against one schema (`src/config-schema.ts`): an unknown key, a wrong type or an out-of-range number stops startup with the setting path, for example `harness.maxConcurency: unknown setting` or `harness.maxConcurrentValidations: must be >= 1`. `workspace.environment` (variable names) and `providers` are open: they accept keys the defaults do not show, so a provider can be overridden or added.
- Relative paths in overrides resolve from the config directory, like the defaults.
- Overrides live in `scrat.local.json`, linked into each release by `scrat update`, which checks it before stopping the service; check an edit with `node src/config.ts`, then restart the service.

Per-install systemd overrides (for example a lower `MemoryMax` on a smaller host) go in a drop-in, `~/.config/systemd/user/scrat.service.d/local.conf` (`/etc/systemd/system/scrat.service.d/local.conf` for a system unit). `scrat install` and `scrat update` never touch it; apply an edit with `systemctl --user daemon-reload && systemctl --user restart scrat.service`.

### Harness and GitHub

| Setting | Purpose |
| --- | --- |
| `harness.maxConcurrency` | Maximum simultaneous tasks, not model sessions or test subprocesses. Each PR review starts two reviewer sessions within one task, and change-mode tasks run a database container and a validation suite, so size this to the host's memory. |
| `harness.maxConcurrentValidations` | Maximum `workspace.validate` runs at once. Further runs wait in a FIFO queue; preparation does not take a slot. |
| `harness.commandTimeoutSeconds` | Longest a `workspace.prepare`, database migrate or `workspace.validate` command may run. It is killed with SIGKILL and the run fails as infrastructure, eligible for validation-only retry, without re-prompting the agent. Heavy commands run by the agent use it as their ceiling too. |
| `harness.commandOutputTailBytes` | Bounded tail of each workspace command's output kept in the run row and in the validation failure sent to the agent; the full output is streamed to `data/checks/<runId>/`, and a failing command's run error also records the path of its full log as `evidence`. |
| `harness.maxOutputBytes` | Output buffer shared by Scrat's internal git and docker calls. |
| `harness.maxStderrBytes` | Stderr kept from a paged git read before further output is dropped. |
| `harness.gitNetworkTimeoutSeconds` | Longest a git clone, fetch, ls-remote or push may run before it is killed. |
| `harness.idlePollSeconds` | How often an idle worker re-checks for queued work when nothing wakes it. |
| `harness.agentTimeoutSeconds` | Longest one agent turn may run; the session is aborted and the run fails with `AGENT_TIMEOUT`. |
| `harness.drainTimeoutSeconds` | How long a running agent turn may continue after the service is told to stop. Past it the turn is aborted; either way the run is recorded as `RUN_INTERRUPTED` and its task is requeued to resume after the restart. |
| `harness.retryJitter` | Fraction (0 to 1) of random extra delay added to each durable review retry delay (see the `retry` action setting), capped at that action's `maxDelaySeconds`. |
| `harness.crashRequeues` | How many times in a row a task is re-queued after the worker crashed during its run (startup recovery). Past that count the run is marked failed instead, so a run that keeps killing the worker cannot loop. |
| `harness.corrections.incomplete` | Times a review session that returns `SCRAT_STATUS: incomplete` is re-prompted in the same session before the run fails as incomplete; 0 disables. Implementations are never continued. |
| `harness.corrections.validation` | Times the agent is re-prompted in the same session after `workspace.validate` fails; 0 disables. |
| `harness.corrections.format` | Times the agent is re-prompted when its final answer is not in the required result format; 0 disables. |
| `harness.agentRetry` | Retries for a failed model request inside a Pi session: `maxRetries` and `baseDelayMs`; 0 retries fails the request at once. |
| `harness.transientErrors` | Regular expressions, case-insensitive, matched against a model error that `@earendil-works/pi-ai` does not classify as retryable, such as a proxy's `stream_incomplete` for a dropped stream. A match is a transient provider error for the `retry` action setting (a context overflow never is); Pi's own in-session retries still follow pi-ai's classifier only. |
| `harness.logTargetChars` | Longest path, pattern, command or revision shown in tool log lines and in the heavy-command refusal message. |
| `harness.logErrorChars` | Longest tool error shown in a `pi.tool_failed` log line. |
| `harness.reviewCacheLimit` / `harness.treeCacheLimit` | Entries kept in the review-relevance cache and the tree-listing cache. |
| `harness.databaseHealthIntervalSeconds` | Seconds between health checks of a run's database container, and between the startup polls that read them. |
| `harness.databaseHealthTimeoutSeconds` | Seconds one database health check may take before it counts as failed. |
| `harness.databaseLogTailLines` | Container log lines quoted in the error when a run's database fails to start. |
| `harness.sqliteBusyTimeoutMs` | Milliseconds a process waits for the Scrat SQLite database lock before failing. |
| `harness.workerErrorDelaySeconds` | Seconds a worker waits after a "Worker failed" error before taking the next task. |
| `harness.sandboxPreflightSeconds` | Seconds the sandbox preflight command may run before it fails. |
| `harness.databaseHealthRetries` | Failed health checks, `harness.databaseHealthIntervalSeconds` apart, before a run's database container is declared unhealthy. |
| `harness.logLevel` | Pino log verbosity, such as `info` or `debug`. |
| `context.inlinePaths` | Most changed paths put inline in the agent's input; beyond it they go to a context file. |
| `context.historyRuns` | How many earlier completed runs of an action feed its `history` context. |
| `context.historyBytes` | Size cap of the `history` context. |
| `relevance.ignoredPaths` | Regular expressions matched against each repository-relative path changed on the base branch, for generated output such as build manifests. A push whose changed paths all match is relevant to no review, and matching paths are left out of the changed paths given to the agent. The default `[]` ignores nothing. |
| `tools.readBytes.default` / `tools.readBytes.max` | Bytes returned by one call of a tool that reads text (the review git tool, `read_base`, the browser's page text) / the cap on its `limit` parameter and on HTTP responses. |
| `tools.git.maxCommits` | Most commits one review git `log` call lists. |
| `tools.git.maxScopeBytes` | Most bytes of file names the review git tool reads to scope a diff. |
| `tools.http.timeoutSeconds` / `tools.http.maxRequestBytes` | Per-request timeout and request body cap of the `http` tool. |
| `tools.browser.steps` / `tools.browser.sessionSeconds` / `tools.browser.navigationSeconds` / `tools.browser.actionSeconds` | Browser actions allowed per agent session, session length, timeout of a navigation (`goto` and the load wait after a click, fill or select), and timeout of any other single action. |
| `tools.browser.viewports` / `tools.browser.defaultViewport` | Named viewport presets (`width`, `height`; names are lowercase letters, digits and hyphens) the browser tool's `screenshot` accepts as `viewport`, and the preset a session starts with; defaults `desktop` and `mobile`, starting on `desktop`. Presets are size-only: no touch or user-agent emulation. A viewport persists until changed. |
| `tools.search.pageSize` / `tools.search.excerptChars` / `tools.search.maxQueryLength` | Results per `github_search` call, characters of each result's body excerpt, and longest query the agent may send. |
| `tools.redactionMarginBytes` | Extra bytes read beyond a tool's output limit so a secret straddling the cut is still redacted. |
| `slack.enabled` / `slack.channel` | Turn Slack status posting on, and the channel ID to post in (see Slack status). |
| `slack.minimumGapMs` | Least time between Slack posts; 0 posts back to back. |
| `slack.maxRetryAfterSeconds` | Longest `Retry-After` Scrat waits out once on a Slack 429; a longer one drops the post. |
| `slack.maxErrorLength` | Longest run failure message quoted in a Slack status post. |
| `slack.maxTextLength` | Longest Slack message Scrat posts; longer text is cut and ends with an ellipsis. |
| `github.repository` | Target GitHub repository as `owner/repo`. |
| `github.repositoryPath` | Local repository clone; relative paths resolve from the config directory. `SCRAT_REPOSITORY_PATH` overrides it. |
| `github.baseBranch` | Default base branch for issues and implementations. Existing PRs use their own base branch. |
| `github.auth` | `"app"` (GitHub App) or `"pat"` (classic personal access token). Startup requires the matching variable, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_PAT`; there is no fallback between modes. |
| `github.botLogin` | The agent's GitHub login, used to recognize its PRs/comments and exclude its own feedback (compared case-insensitively). `name[bot]` for the App; the plain account login for a PAT. |
| `github.botName` | Display name the agent uses in prompts and generated text. Its lowercase slug (`Mocha Agent` becomes `mocha-agent`) is also the implementation-selection label and the prefix of new branches. |
| `github.appId` | GitHub App ID (ignored in PAT mode). |
| `github.installationId` | App installation granting access to the target repository (ignored in PAT mode). |
| `github.fetchIntervalSeconds` | Delay between service syncs. The service also syncs on startup. |
| `github.readConcurrency` | Maximum concurrent GitHub item reads, in sync reconciliation and task routing. |
| `github.maxCachedResponses` / `github.maxCachedChars` | Most GitHub responses, and total characters of them, kept for conditional requests. |
| `github.rateLimitLowFraction` | Fraction (0 to 1) of the hourly GitHub quota below which sync defers its remaining item reads to the next interval (logged as `github.sync_deferred`); worker publication is never deferred. |

### GitHub authentication

Two modes are supported; `github.auth` picks one.

- **App (default).** A GitHub App installation token, minted per repository and per permission set (the check-run request uses a separate `checks: read` set and storefront preview deployments a separate `deployments: write` set, so an App without one of them loses only the GitHub checks section or the preview's deployment).
- **PAT.** A classic personal access token from a dedicated account that has write access to the repository (an outside collaborator is enough). Put `GITHUB_PAT=ghp_...` in `.env`; `GITHUB_APP_PRIVATE_KEY`, `appId` and `installationId` are not used.

Example `scrat.local.json` for a PAT deployment (every key already exists in the defaults, so the override loader accepts it):

```json
{
  "github": { "repository": "acme/widgets", "auth": "pat", "botLogin": "mocha-agent", "botName": "Mocha" },
  "actions": { "address_review": { "exhaustedLabel": "Mocha repair exhausted" }, "implement": { "failedLabel": "Mocha failed" } }
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

Renaming the bot: the label (`github.botName` slug) and branch prefix apply to new work. Issues labelled with the old name stop being selected, existing branches and PRs keep their names, `actions.address_review.exhaustedLabel` and `actions.implement.failedLabel` are separate settings, and a resumed Pi session keeps the old name in its history. Relabel open issues when renaming.

### Workspace

On Linux, `workspace.sandbox: true` (set in deployment overrides) runs repository
preparation, validation, agent Bash and workspace Git (including hooks) inside
Bubblewrap. Enabling it is fail-closed: missing namespaces or runtimes are errors,
not a fallback to host execution. `scrat update` checks the boundary before stopping
the old service. On Ubuntu 24.04, `scrat install` installs `bubblewrap` and loads
`deploy/scrat-bwrap.apparmor` as `/etc/apparmor.d/scrat-bwrap` (`apparmor_parser -r`).
Do not disable the global userns restriction. The sandbox mounts the pnpm that Corepack
activated for `packageManager` in `deploy.json`. The browser tool's Chromium has its own
profile, `deploy/scrat-chromium.apparmor`; see the browser tool section.

`workspace.packageStore` (off unless set) is an absolute directory, not a symlink, that is bind-mounted read-write at pnpm's store
location in every sandboxed command, with a `storeDir` entry written to the sandbox home's pnpm `config.yaml` so
pnpm uses it. A lockfile's packages are then downloaded once per install instead of once per workspace. It requires
`workspace.sandbox`, and the sandbox preflight of `scrat update` writes to it. This is opt-in and meant for repositories whose
contributors are trusted: the store is shared mutable state across that install's sandboxes. pnpm's integrity check
(`verify-store-integrity`, on by default) only re-hashes file contents, so a malicious repository command could rewrite a
package's index entry and poison later installs of the same lockfile; a read-only store filled by a trusted fetch step
would close that and is a possible follow-up. Nothing else is shared: each workspace keeps its own `node_modules` and
runs its own `prepare`. The store and the workspace are different mounts, so pnpm copies files instead of hardlinking:
the saving is download time and the per-run sandbox home, not disk in `node_modules`.

`workspace.commandMemoryMax` (off unless set) is a systemd `MemoryMax=` value such as `"6G"`
or `"50%"`; it requires `workspace.sandbox` and a systemd user session. Each sandboxed command
then runs in its own transient scope with swap disabled, so a runaway check is killed alone and
its run fails as out of memory (`COMMAND_OUT_OF_MEMORY`), without the agent being re-prompted. Only prepare, migrate and validate commands get that
classification; the agent's bash tool and Git are bounded too, but a kill there surfaces as an
ordinary failed command. The transient scopes live outside `scrat.service`'s cgroup, so the unit's
`MemoryMax` and `KillMode` no longer cover them; bwrap's `--die-with-parent` ends them when Scrat exits.

Commands get the workspace, their own persistent home, private `/tmp`, `/run` and
process namespace, read-only system/Node/pnpm runtimes, read-only repository Git
objects, and (for Bash) their own context directory. They do not get controller
credentials/data, other workspaces, host process environments or the Docker socket.
Workspaces are private Git clones that borrow the repository clone's objects (`git clone --shared`; Scrat sets `gc.auto=0` there and pins each workspace base under `refs/scrat/workspaces/<id>`), which works on any OS without Bubblewrap. The controller
imports published commits through a checked incremental Git bundle (only the commits the clone lacks) rather than executing Git
in a writable shared repository. Review-workspace cleanup also removes its private
home; retained implementation workspaces keep theirs for retries.

Networking stays enabled. Apply VM/hypervisor egress rules separately: deny private,
link-local and local IPv6 networks except explicit DNS/provider dependencies, while
preserving management/monitoring replies. Test databases use per-run random
passwords; these are the only database credentials repository commands receive.
This is OS isolation, not a guarantee against kernel exploits, resource exhaustion,
or exfiltration of workspace content over permitted internet access. The service
account should have no sudo; administration belongs to a separately verified login.

Workspace commands are argument arrays, not shell strings: `["pnpm", "verify"]`. Command lists execute sequentially inside the workspace; a failing command stops the run. Each run stores a measured check per command (name, status, duration, a bounded tail, and the path of the file holding the full output) in `runs.verification`, not the raw output.

| Setting | Purpose |
| --- | --- |
| `workspace.environment` | Environment variables added to Pi's Bash commands and harness preparation/validation commands. These commands inherit only path, home, user, locale, temporary-directory, proxy, certificate and `DOCKER_HOST` settings, so any other variable they need belongs here. Test-process limits belong here too; task concurrency does not serialize tests. |
| `workspace.prepare` | Setup commands, including dependency installation and code generation. Also used for PR reviews; issue, commit, window and storefront reviews skip it. Rerun before mutating-work validation. |
| `workspace.heavyCommands` | Regular expressions, matched against each shell command segment of Pi's Bash tool, with quoted text ignored and whitespace collapsed (leading `VAR=value`, `env`, `nohup`, `time`, `sudo`, `exec` and `timeout N` are stripped). A foreground match is queued, not refused: it runs in one of the `harness.maxConcurrentValidations` slots, shared with Scrat's own validation, and logs `pi.heavy_command` with its wait. It may hold the slot for at most `harness.commandTimeoutSeconds`, and a cancelled run leaves the queue. A command that backgrounds work (a background `&`, `nohup`, `setsid` or `disown`) is refused instead, because the job would outlive its slot; the agent is told to run it in the foreground. This is a speed bump against accidental parallel lint/type-check/verify runs, not a sandbox: `sh -c '...'` or a script can still evade it. |
| `workspace.validate` | Required checks for mutating tasks before committing or publishing. Not run as a harness gate for read-only reviews. |
| `workspace.sandbox` | Run preparation, validation, agent Bash and workspace Git inside Bubblewrap (see above). |
| `workspace.database` | Per-run PostgreSQL container configuration for mutating tasks; `null` disables it. |
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

Each action is one manifest, `actions/<name>.yaml`, validated at startup (`src/manifests.ts`): `review_issue`, `review_pr`, `implement`, `resolve_conflicts`, `address_pr_feedback`, `address_review`, `review_base_change`, and `storefront_discover` (queued only while `storefront.enabled` is true; see Storefront previews), `store_audit` (off by default; see Scheduled store audit), and `review_store_change` (off by default; see Shopify admin changes). A manifest fixes the trigger, mode, acceptance rule, `tools` the agent session gets, context `files`, and publish effects, all from closed lists; an unknown key or value stops startup with the file and path. The settings below are the manifest's deployment-level keys, and `scrat.local.json` overrides them by action name.

| Setting under `actions.<action>` | Purpose |
| --- | --- |
| `priority` | Default queue priority; higher values are claimed first. Manual enqueue can override it. Running tasks are not preempted. |
| `skill` | Prompt file, resolved relative to the config directory. |
| `channel` / `browserSteps` / `browserSeconds` / `rootInstructions` | Schedule and Shopify manifests that publish `slack_reply` (`store_audit`, `review_store_change`): the Slack channel ID, the browser actions and seconds one session may use (instead of `storefront.limits`), and the instruction that shapes the agent's first line, the opening Slack message. |
| `provider` / `model` | Provider name and model ID for the action. For PR reviews, these select the consolidator. |
| `thinkingLevel` | Requested Pi reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; provider/model support determines its mapping. |
| `reviewers` | PR review panel: exactly two entries, each with its own `provider`, `model`, and `thinkingLevel`. |
| `maxSelfRepairs` | `address_review` only: most self-repair runs started for one PR; 0 disables self-repair; not enqueueable manually. A push makes the review stale and Scrat re-reviews; a reply-only repair is not retriggered for the same assessment. |
| `retry` | Review-mode actions only, optional: `{ initialDelaySeconds, maxDelaySeconds }` (max not below initial). When every reviewer of a review (or its consolidation) fails at the agent stage with a transient provider error that survived Pi's own short retries (classified with `@earendil-works/pi-ai` or matched by `harness.transientErrors`: context overflow, quota/billing exhaustion, auth and setup errors, incomplete results and agent timeouts are excluded, and one permanent reviewer failure keeps the task failed), the failed run and its error are kept and the task is requeued with exponential backoff: `initialDelaySeconds`, doubled per attempt, capped at `maxDelaySeconds` (the delay is capped, not the attempt count), plus up to `harness.retryJitter` of random jitter. The retry count and next-attempt time are stored on the task; delayed tasks are not claimed until due and hold no worker slot, and the backoff survives restarts. A changed trigger or `npm run enqueue` resets the count and delay, `npm run retry -- <task-id>` on the delayed task makes it due now, and a successful run resets it. The `run.requeued` journal event carries `attempt` and `nextAttemptAt`, and the Slack status shows the time. A review restarted from the start uses the currently configured models and reviewers, not the failed run's, so changing a provider in `scrat.local.json` and restarting rescues delayed reviews. A retried panel review (durable or `npm run retry`) whose two reviewers both completed reuses their saved results and reruns only the consolidation when the task input, the base and head SHAs, the discussion revision, the configured reviewer models and whether the storefront was checked are unchanged, and journals `run.reviewers_reused` with `fromRunId`; a drain or crash during the consolidation still reruns both reviewers (#214). Omitted means no durable retries; `null` in `scrat.local.json` disables a shipped default. |
| `exhaustedLabel` | `address_review` only, optional: label added to a Scrat PR whose current review is graded C or lower once `maxSelfRepairs` is reached, and removed when its current review grades better. `null` or `""` (e.g. in `scrat.local.json`) disables it; GitHub creates the label if it is missing. A repair counts toward `maxSelfRepairs` when it starts running, not when it is queued or cancelled. |
| `failedLabel` | Change-mode actions only, optional (`implement` ships `Scrat failed`): label kept on the issue or PR while the latest task of this action there has failed for good, so `label:"Scrat failed"` lists every stuck item. Sync reconciles it from the database each round and writes only when it changes: the next sync removes it once that task is retried, superseded or cancelled, or once the item loses the selection label that selected it, and restores it if a human removes it while the task is still failed. An interrupted or delayed task is queued, not failed, and is not labelled. `null` or `""` disables it; GitHub creates the label if it is missing. |

### Adding an action

A deployment adds or changes actions without a code release. Set `actions.directory` in `scrat.local.json` to an absolute path outside the release (on the VM, `~/.local/share/scrat-v2/actions`, which `scrat install` and `scrat update` create):

```json
{ "actions": { "directory": "/home/bek/.local/share/scrat-v2/actions", "review_issue": { "enabled": false } } }
```

- Every `*.yaml` directly in that directory is a manifest, loaded after the shipped `actions/*.yaml`. The file name must equal `name` (lowercase letters, digits and underscores; `directory` is reserved). A file whose `name` matches a shipped action replaces that whole manifest, which is how a deployment changes its `tools`, `files`, `context`, `publish` or `trigger`; any other name adds an action.
- Overrides in `scrat.local.json` apply by name after both sets are merged: `enabled`, `priority`, `skill`, `provider`, `model`, `thinkingLevel`, `reviewers`, `branch`, `cron` and `window` (schedule manifests only), `channel`, `maxRangeCommits`, `startMessage`, `browserSteps`, `browserSeconds`, `rootInstructions`, `maxSelfRepairs`, `exhaustedLabel`, `failedLabel`, `retry`. Everything else (`trigger` apart from those, `mode`, `agent`, `context`, `tools`, `files`, `acceptance`, `commitPrefix`, `start`, `publish`) is structural and changes only by shipping a manifest.
- A relative `skill` resolves against the directory the manifest came from, so a deployment keeps `<directory>/skills/<name>/SKILL.md` beside its YAML. Absolute paths work too.
- Routing picks the action whose `trigger` matches what sync observed: `source` and `kind`, then `item` (`issue` or `pr`), `author: bot` (the item is authored by `github.botLogin`) and `grades` (for `low_grade`). `manual: false` stops `enqueue` by hand. Only an enabled match routes: a signal whose matching actions are all disabled queues nothing, and a selection label whose `label` action is disabled selects nothing.
- Two enabled manifests may not share a trigger: startup fails naming both files. To give a trigger to a new action, disable the shipped one that owns it (`"review_issue": { "enabled": false }` above). The selection label still decides between the `label` and `item_changed` issue triggers.
- At most one enabled `review` manifest per `trigger.item` may publish `comment`, because they would share that item's one assessment comment; startup fails naming them.
- `tools` is the list of agent tools (`read`, `grep`, `find`, `ls`, `git`, `read_base`, `bash`, `edit`, `write`) and the scoped tools `http`, `browser` and `github_search` (see Scoped tools below); `review` manifests get no write tools and `change` manifests no `git` or `read_base`. `files` lists the optional context files written for the run (`discussion`, `review`, `previous_assessment`, `previous_repair`, `history`, `validation`, `triage`, `issue`, `storefront`, `cloudflare`); `history` and `validation` are opt-in. `validation` lists the checks Scrat ran on the reviewed head (name, status, duration), when one of its own change runs published that head, and, independently of that, the head's completed GitHub check runs (name and conclusion, fetched once per run, so a human PR gets just that section; a failed request is logged and skipped). Published PR bodies and address comments end with a harness-written `Validated on <sha>: <checks> passed.` line. `triage` (issue triggers) is the issue's latest completed review by an action that publishes `labels`, written only when that review marked the issue ready. `issue` (PR triggers) is the title and body of the issue whose implementation run opened the PR; a PR Scrat did not open gets none. `storefront` (manifests that publish `pr_assessment` or have a `storefront` trigger) is the storefront context: `storefront.json` and the stored site map (see Storefront previews), written only while `storefront.enabled` is true; a manifest that lists it may list `browser` without a `browser` setting to get the storefront browser. `cloudflare` (issue triggers) is `cloudflare.md`, the Cloudflare issue behind a GitHub issue Scrat filed (see Cloudflare Workers issues), written only while `cloudflare.enabled` is true. `publish` lists effects (`push`, `pull_request`, `comment`, `labels`, `pr_assessment`, `issue`, `slack_reply`, `site_map`). In a `review` manifest `comment` keeps one assessment comment per item, marked `<!-- scrat-review -->` and edited in place, and `previous_assessment` then holds the action's last completed assessment; in a `change` manifest each task posts its own comment. An unknown name or key stops startup with the file and path.
- Omitted, `agent` is `single` (`panel` needs exactly two `reviewers`), `context` is `all`, and `tools` is `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` for a `change` manifest or `read`, `grep`, `find`, `ls`, `git` for a `review` one, plus `read_base` for a panel or `context: change`.
- `acceptance` (required for `change` manifests, forbidden for `review` ones) decides what counts as publishable work. `complete` accepts any complete result: a run that leaves the workspace unchanged publishes its reply directly, otherwise the change is validated and committed. `nonempty_diff` validates and commits the same way but expects the branch to differ from its base; a run whose branch ends with no difference publishes its reply as a comment only, with no push and no PR. `conflict_free` validates and commits, then fails the run if the PR still conflicts with its base.
- `commitPrefix` (optional, `change` manifests only) starts the message of the commit Scrat makes for the agent's work, as in `Address review: <PR title>`; without it that commit uses the conventional title (`fix: <title>` unless the title already has a type). A commit that concludes a merge keeps git's merge message either way.
- Manifests are read once at startup: restart the service to apply a change. The supervised repository never contributes manifests.

A `schedule` trigger runs a `review` action on a cron expression instead of on a GitHub event. No shipped action sweeps logs; this illustrative manifest (a deployment would add it with its own skill) sweeps logs every six hours and opens an issue for each problem it reports:

```yaml
name: error_sweep
trigger: { source: schedule, kind: tick, cron: "0 */6 * * *", window: 6h }
mode: review
tools: [read, grep, find, ls, http]
files: [history]
publish: [issue]
skill: skills/error_sweep/SKILL.md
model: { provider: codex-lb, model: gpt-6.1-sol, thinkingLevel: high }
priority: 20
```

- `cron` has five UTC fields (minute, hour, day-of-month, month, day-of-week; 0 and 7 are Sunday), each a `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma list of those. When both day fields are restricted, either one matching is enough. `window` is a number of minutes, hours or days: `90m`, `6h`, `1d`. A schedule manifest must be `mode: review`, and several may be enabled at once.
- Each manifest keeps its own cursor: the next tick. The first poll after enabling records the next tick and queues nothing; disabling deletes the cursor. The cursor also records the `cron` and `window` it was computed from; changing either (in the manifest or under `actions.<name>` in `scrat.local.json`, validated at startup like the manifest's own) re-seeds the schedule from the next poll: Scrat logs `schedule.reseeded` and queues nothing for the old expression. A cursor written before this was recorded keeps its next tick. When a tick is due, Scrat queues one task on a `window` subject keyed `<action>:<tick>` with `start` (the tick minus `window`) and `end` (the tick) in its metadata. Ticks missed while the service was down fire once, for the latest one.
- The agent gets the base branch checked out read-only, the window as `input.start` and `input.end`, and no GitHub issue or PR. List `history` to give it its earlier reports, and `issue` in `publish` to open the problems it finds. A schedule manifest may also list `storefront` in `files` with `browser` in `tools`, `slack_reply` in `publish` (which then needs `files: storefront`) and the settings `channel`, `browserSteps`, `browserSeconds` and `rootInstructions` (see Scheduled store audit).
### Scoped tools

No shipped manifest lists `http` or `github_search`, and the only shipped `browser` is the storefront browser of `storefront_discover` and `review_pr`; a deployment manifest opts in by naming the tool in `tools` and, for the first two, adding the matching setting. Each tool is built only for a manifest that lists it.

**Bindings** carry credentials and live only in deployment config, never in manifests. Define them under `bindings` in `scrat.local.json` (the default is `{}`):

```json
{ "bindings": { "logs": { "secret": "${LOGS_API_TOKEN}", "hosts": ["api.logs.example.com"], "header": "Authorization", "prefix": "Bearer " } } }
```

- `secret` must be a `${VAR}` placeholder naming an environment variable that is set at startup. The value is registered as a secret (redacted from output and logs, caught by the publication scan) and is never passed to child processes.
- `hosts` is a non-empty list of exact lowercase hostnames. IP literals, `localhost`, `*.local`, `*.internal`, `*.localhost` and cloud metadata hostnames are refused, as are wildcards.
- `header` is the request header the harness sets (`Authorization`, `X-Api-Key`, ...); `Host`, `Cookie`, `Content-Length` and other transport headers are refused. `prefix` is optional text put before the secret (`"Bearer "`).
- Startup fails on any violation, and on a manifest naming a binding that is not defined.
- Every binding host is resolved once at startup, and startup fails if any answer is loopback, private, link-local, CGNAT, ULA, unspecified or a metadata address; a host that does not resolve only logs `bindings.unresolved`.

**`http`** takes `http: { binding: <name>, methods?: [GET, ...] }` in the manifest (methods default to `GET`; `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE` are the others). The agent calls it with `{ method, url, body?, headers? }`. Only `https` URLs on the binding's `hosts` are allowed, with no credentials in the URL and no explicit port; IP literals (including `2130706433`-style forms), loopback, link-local and metadata addresses are refused. The harness adds the binding header after the model's call; the model may set only `Accept`, `Accept-Language`, `Content-Type`, `If-None-Match` and `If-Modified-Since`, and any other header is refused. Redirects are never followed: a 3xx comes back as is, with `Location` kept only when it points at another host of the binding. Each connection resolves the host itself and is refused when any answer is in a private range (the checked address is the one connected to, with SNI and `Host` unchanged). Responses are capped at `tools.readBytes.max` bytes and pass through secret redaction. The journal records method, host and status, never the query string or body.

**`github_search`** needs no setting and is allowed in `review` manifests only. The agent calls it with `{ query }`; the harness prefixes `repo:<github.repository>` and refuses any query containing `repo:`, `org:`, `user:` or `owner:`. It returns up to 20 issues and pull requests with number, kind, title, state, URL, author, labels and a 300-character excerpt, all untrusted text.

**`browser`** takes `browser: { navigationHosts: [..], resourceHosts: [..], binding?: <name> }`. The agent calls it with `{ action, url?, selector?, text?, viewport?, fullPage? }` where `action` is `goto`, `text`, `screenshot`, `click`, `fill`, `select` or `reset`. `screenshot` saves a PNG in the run's context directory (`screenshot-<viewport>-<n>.png`, prefixed `reviewer-<n>-` in a panel reviewer's session so concurrent reviewers never overwrite each other's evidence), after setting the viewport to the `viewport` preset (a name from `tools.browser.viewports`) when given and capturing the whole page when `fullPage` is true, appends its path, preset and final URL as one JSON line to `screenshots.jsonl` there, and returns the path, preset, final URL and, when the page declares a `Shopify.theme = {...}` global, its `themeId`. `click`, `fill` (put `text` in the field) and `select` (choose the option `text`) act on the element matching `selector` and return the resulting URL, title and `themeId` (as does `goto`), plus the number of elements `selector` matched before the action when the page did not navigate, `popupClosed: true` when a new window opened (it is closed at once), and `blocked: <url>` when a navigation was refused. `fill` and `click` can submit forms on allowed hosts, including with the binding's header, which `goto` alone could not. The viewport persists until changed. They count against the same step cap, and a navigation they trigger goes through the same request routing as `goto`, so it is blocked unless the host is in `navigationHosts`. One Chromium process with a fresh context and no profile is used per agent session; `reset` closes that context, so the next action opens another in the same process with no cookies or storage, at the viewport last set; every request is routed, and one whose host is not allowed is aborted: navigations (documents and frames) need `navigationHosts`, other requests need `resourceHosts` or `navigationHosts`. A binding, when named, adds its header only to requests for the binding's hosts, and the header is removed from requests to any other host. Calls run one at a time, and each agent session (a panel review's reviewers and consolidator, or a validation follow-up, are separate sessions) gets at most `tools.browser.steps` browser actions (`reset` counts) and `tools.browser.sessionSeconds` seconds from the first start, resets included, each navigation bounded by `tools.browser.navigationSeconds` and every other action by `tools.browser.actionSeconds`; an empty `viewport` counts as none; page text is capped at `tools.readBytes.default` characters. Playwright is an optional peer dependency (`playwright-core`) loaded lazily, so deployments without a browser action pay nothing, and startup fails with a clear message when an enabled manifest lists `browser` and the package or Chromium is missing. One-time install on the host:

```sh
cd ~/.local/share/scrat-v2 && npm install --no-save --no-package-lock playwright-core@^1.50.0 lighthouse@^13.5.0
PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/scrat-v2/browsers npx playwright-core install chromium
sudo env PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/scrat-v2/browsers npx playwright-core install-deps chromium   # system libraries, once, as root
```

Run the service with the same `PLAYWRIGHT_BROWSERS_PATH`. The packages live in the install root, where Node's resolution from every release finds them, so they survive `scrat update`, which checks that they resolve before stopping the service when `storefront.enabled` is true. Chromium is launched with its sandbox enabled (`chromiumSandbox: true`) and as the full Chromium build (`channel: "chromium"`, new headless mode) rather than Playwright's separate headless shell, so one AppArmor attachment covers it; `npx playwright-core install chromium` installs both the full build and the headless shell, and the profile covers both. On Ubuntu 24.04,
where `kernel.apparmor_restrict_unprivileged_userns = 1` blocks the sandbox, `scrat install`
installs `deploy/scrat-chromium.apparmor` as `/etc/apparmor.d/scrat-chromium` and loads it with
`apparmor_parser -r`; it attaches to Chromium under
`$HOME/.local/share/scrat-v2/browsers` or Playwright's default `~/.cache/ms-playwright`, so a
browser installed elsewhere needs the path adjusted. Do not disable the global userns restriction.

When a session's browser starts, each allowed host is resolved and Chromium is launched with `--host-resolver-rules` mapping it to that address (`~NOTFOUND` when it does not resolve); the browser tool refuses the run if any host resolves to a private address. A network namespace with no route to private ranges is the stronger boundary and belongs to the VM deployment, not the code.

**The storefront browser.** A manifest that lists the `storefront` file may list `browser` without a `browser` setting. That browser exists only in a session whose storefront context has something to browse, a discovery or a review of a preview that matches the head (see Storefront previews), and is otherwise dropped from the session's tools, so an install with `storefront.enabled` false never gets it. It has no host allowlist, by the owner's decision, and the skills that use it tell the agent which hosts to stay on. What that allows: the agent can navigate, load resources, `fill` and `click` on any public `https` host, so if page text talks it into it, anything the session can read (the theme repository, its context files, and in a review the diff and the issue) can leave in a URL or a form post. What still holds: no binding and no credential reaches this browser; URLs with credentials, IP literals and explicit ports are refused, as are local and metadata host names; each new host is resolved once per session and a navigation or request to a name with a private, loopback, link-local or metadata answer, or with no answer, is refused; Chromium's certificate checks stay on; and the `http` tool is unchanged. Chromium resolves names itself after that check and no `--host-resolver-rules` pin them, so the VM's network namespace, with no route to private ranges, stays the real boundary. A storefront manifest that declares a `browser` setting gets that allowlist instead, so the mechanism above stays available. Its budget is `storefront.limits.browserSteps` actions and `storefront.limits.browserSeconds` seconds per agent session instead of `tools.browser.steps` and `tools.browser.sessionSeconds`; `tools.browser.navigationSeconds`, `tools.browser.actionSeconds`, the viewports and the page text cap still apply. Startup checks for Playwright and Chromium only while `storefront.enabled` is true.

A `github_commits` trigger reviews pushes to a branch. This manifest reviews each commit by `alice` whose message contains `[review]` on `release`:

```yaml
name: review_release_commits
trigger: { source: github_commits, kind: commit, branch: release, granularity: commit, author: alice, message: "[review]" }
```

- `branch` is any branch of the repository; Scrat fetches it into the same clone. Each manifest keeps its own cursor per branch, so manifests on different branches, or on one branch with different `author` or `message`, may be enabled together. Two enabled commit manifests with the same branch, `author` and `message` stop startup.
- `granularity` is `range` or `commit`. `range` queues one task per push, covering the commits since the last seen tip. `commit` queues one task per first-parent commit, oldest first, each reviewed against its own parent. At most `maxRangeCommits` commits are queued per poll; the recorded tip then stays at the last queued commit and the rest follow on the next poll.
- `author` is a login or `bot` (`github.botLogin`). It matches, case-insensitively, a commit's author name or the login in a `users.noreply.github.com` author email. `message` is a plain, case-sensitive substring of the full commit message. Both are only allowed on `github_commits` (`author: bot` also on `github_items`). They apply to each first-parent commit: with `commit` only matching commits are queued, with `range` the push is reviewed if any commit in it matches. The recorded tip advances to the new tip either way, except when the `commit` cap leaves matching commits unqueued.

### Optional actions

An action runs unless its `enabled` is `false`. Only `review_base_change` ships with `enabled: false` (in `actions/review_base_change.yaml`); a deployment turns it on in `scrat.local.json`:

```json
{ "actions": { "review_base_change": { "enabled": true, "channel": "C0123456789" } } }
```

Disabling an action stops its queued tasks from being claimed. For a disabled action, startup skips the skill file check and the settings checks.

### Slack status

Scrat can post its work to Slack: one thread per issue or pull request, with every later update as a reply. It is off by default, and a disabled Scrat makes no Slack calls.

```json
{"slack":{"enabled":true,"channel":"C0123456789"}}
```

Put that in `scrat.local.json`. `channel` is a channel ID, not a name. Both this and `review_base_change` post through one Slack bot:

1. Create a Slack app in the workspace, from scratch.
2. Under OAuth & Permissions, add the bot token scopes `chat:write` and `reactions:write` (review verdict reactions), then install the app to the workspace; an app installed before `reactions:write` was added must be reinstalled to pick up the new scope.
3. Copy the Bot User OAuth Token (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN=xoxb-...`.
4. Invite the bot to the channel (`/invite @<bot name>`).

The token comes only from the environment, never from `scrat.config.json`. Scrat redacts it from logs and errors, refuses to publish text that contains it, and does not pass it to agents or workspace commands. Startup calls Slack's `auth.test` with the token whenever Slack status or `review_base_change` is enabled, and a failure stops startup. Startup fails when `slack.enabled` is true and the channel or token is missing. Startup does not test posting, so a bot that was never invited is found by the first post, which fails and is logged.

The first update for an item posts a root message with its kind, number, title and link, and the thread is stored so a restart never opens a second one. Changing `slack.channel` starts a new thread in the new channel. Replies cover: a run starting, completing or failing (with the stage and the redacted error), a repair or validation round queued, comments posted or updated, labels added or removed, commits pushed, and issues or pull requests created. A pull request Scrat opens is announced in the thread of the issue it came from. Queueing, coalescing and cancelling are not posted. Messages contain only titles, links, actions, stages, labels and redacted error messages, never command output.

Posting is best effort. It runs after the database write, one message at a time, at least a second apart, and a 429 is retried once after its `Retry-After`. A failed post is logged as `slack.post_failed` and dropped: it never changes a task's outcome, and a failed root is tried again with the next update.

### Base branch review

`review_base_change` reviews each update to `github.baseBranch` and reports the review in Slack. It runs on the `github.fetchIntervalSeconds` interval and at startup. It queues one review per push range by default, or one per commit with `granularity: commit`. Commits can be filtered by `author` or `message` (see `github_commits` above), and Scrat's own merged commits are reviewed unless filtered out.

For each review, Scrat posts `startMessage` to the channel as the opening message, then replies in that thread with the review: a one-line verdict followed by at most five bullets, highest consequence first, and at most `slack.maxTextLength` characters.

Once the reply is saved, Scrat reacts on the opening message with the review's verdict: `white_check_mark` (clean), `large_orange_square` (concerns) or `large_red_square` (breaking: an incompatible change to a contract callers or consumers use; it wins over concerns). The agent ends its review with `SCRAT_VERDICT: clean|concerns|breaking`, which is kept out of the reply. An incomplete review or a missing verdict gets no reaction.

The agent receives the commit messages, the changed paths and the diff for the range. It has read-only tools, including `read_base` for the commit before the range. It does not install dependencies, run validation, open a PR or post to Slack, and it never sees the Slack token.

| Setting under `actions.review_base_change` | Purpose |
| --- | --- |
| `enabled` | Ships `false`; set `true` in `scrat.local.json` to turn the action on. |
| `reviewers` | Required with exactly two entries when the manifest sets `agent: panel` (the shipped manifest runs one session, and `provider` and `model` consolidate a panel into one reply); each takes `provider`, `model` and `thinkingLevel`. |
| `branch` | Branch to watch, the manifest's `trigger.branch` by default; must not be empty. |
| `channel` | Slack channel ID to post in. Required when enabled, and the bot must be a member of it. |
| `maxRangeCommits` | Range granularity: a range with more first-parent commits is recorded as `truncated` and still reviewed whole. Commit granularity: most commits queued per poll. |
| `startMessage` | Opening message template. Variables: `{{sha}}` (tip commit), `{{short_sha}}`, `{{author}}` (commit author name), `{{title}}` (commit subject), `{{url}}`, `{{branch}}`, `{{count}}` (commits in the range), `{{bot}}` (`github.botName`) and `{{change}}` (a plain-language, linked description of the tip commit: the pull request title, number and merger for a merged pull request, the edited areas for a Shopify theme editor change, or the author and commit subject for a direct change, plus the number of other commits in the range). Any other `{{name}}` stops startup. |
| `priority`, `skill`, `provider`, `model`, `thinkingLevel` | As in the table above. |

Author and title are escaped for Slack. Messages do not unfurl links or ping users by name.

With `storefront.enabled`, a review of `github.baseBranch` also checks the live store and posts a storefront block as a second reply in the thread; its verdict can raise the reaction (see Main-branch storefront review below).

On the first run after enabling, Scrat records the current tip and reviews nothing. Disabling deletes that record, so enabling again starts from the new tip and does not review the commits pushed while the action was off.

If the recorded tip is no longer an ancestor of the new tip (a force-push), Scrat reviews from the merge base of the two when the old tip is still in the clone. A new tip behind the recorded one, or one with no merge base, starts again from the new tip without a review. These cases are logged as `commits.cursor_rewound` and `commits.cursor_reset`.

Failures:

- Slack is unreachable when the run starts: Scrat logs `slack.post_failed` and runs the review anyway. The opening message is posted with the reply.
- Slack is unreachable when the reply is posted: the run fails at publishing. `npm run retry -- <task-id>` reuses the saved review and posts only the reply to the thread, without running the agent again.
- The reaction fails after the reply is posted: the run fails at publishing and the `slack.add_reaction` operation logs `operation.failed`. `npm run retry -- <task-id>` adds only the reaction, without posting the reply or running the agent again; a reaction that is already there counts as added.
- Slack has no idempotency key. A crash after Slack accepts a message but before Scrat records its timestamp can post that message again on retry, either the opening message or the reply.

### Storefront previews

For a Shopify theme repository, Scrat can give each pull request it opened an unpublished preview theme in the store. It also keeps a site map of the store for its storefront reviews. It is opt-in and off by default: while `storefront.enabled` is `false` Scrat does not load the storefront code, makes no Loggie or Shopify call, never queues `storefront_discover`, and no session gets the storefront context or browser, so prompts and tools are the same as without the feature.

```json
{ "storefront": { "enabled": true, "store": "perelel.myshopify.com", "publicHost": "perelelhealth.com", "loggie": { "slug": "shopify-perelel-myshopify-com" } } }
```

All Shopify access goes through Loggie's HTTP proxy (`POST <loggie.url>/api/proxy/<loggie.slug>/`, Admin GraphQL), authenticated with a Loggie API key in the `x-api-key` header:

1. In Loggie, create a profile for Scrat on the store's Shopify integration, separate from other tools' profiles (rate limits are per profile), whose policy allows exactly six operations: `themes`, `theme`, `themeDuplicate`, `themeFilesUpsert`, `themeFilesDelete` and `themeDelete`. Everything else, including `themePublish`, `themeUpdate` and `themeFilesCopy`, is refused with `403 ENDPOINT_RESTRICTED`.
2. Put the profile's key in `.env` as `LOGGIE_API_KEY=...` and restart the service.

Startup fails when `storefront.enabled` is true and `LOGGIE_API_KEY`, `storefront.store`, `storefront.publicHost` or `storefront.loggie.slug` is missing, `storefront.publicHost` is not a bare host name, `storefront.loggie.url` is not an absolute URL, `storefront.preview.themePaths` or `storefront.siteMapPaths` is not a valid regular expression, or `workspace.sandbox` is off. Without the sandbox the agent's Bash runs as the service user and could read the key from `.env` or the service's environment, and the key can change the live theme.

- Before each review that publishes `pr_assessment` (`review_pr`) of a PR authored by `github.botLogin`, Scrat gets or creates the PR's preview. It records the preview in the `theme_previews` table, reads the `MAIN` theme's ID at run time, duplicates it as `<preview.themeNamePrefix>pr-<number>`, records the new theme's ID (also when Shopify's reply carries errors next to it), and polls its `processing` flag every `preview.processingPollSeconds` until Shopify has processed it (about two and a half minutes for a 650-file theme), for at most `preview.processingWaitSeconds` per review. It then stores the duplicate's own file checksums as the preview's baseline. A later review reuses the recorded preview; one that found it still processing waits again. If the duplicate's reply was lost (a timeout, a proxy error or a restart), the next review adopts the unpublished theme with exactly that name instead of duplicating again.
- Scrat then syncs the PR onto the preview whenever the reviewed head differs from the one last verified; a review of a verified head makes no Loggie call, and a head whose preview is unavailable is synced again by the next review. Before every sync Scrat reads the theme: one gone from the store is marked deleted, and one that is no longer `UNPUBLISHED` (someone published it) is never written again; the preview is shown as unavailable instead.
- The files to sync are those changed between the merge base and the head plus every file Scrat wrote in an earlier sync, limited to paths matching `preview.themePaths`, so the live `config/settings_data.json` and JSON templates stay unless the PR changes them. A file the PR changes gets its content at the head, or is deleted when the PR deletes it (a rename is a delete plus an upload). A file Scrat wrote earlier that the PR no longer changes is copied back from the live `MAIN` theme (its text, base64 or URL body), or deleted when the live theme has none, so a revert never puts the merge base's copy over the merchant's later edits. A copied file whose bytes do not match the live theme's checksum is not uploaded and is listed as a problem. A file that already matches what the theme holds is skipped, so a head move sends only the delta.
- Uploads go in batches of at most `preview.uploadBatch` files (Shopify rejects a whole batch above 50) and `preview.uploadBatchBytes` bytes of encoded content (a larger file goes alone), text as `TEXT` and binaries as `BASE64`, each batch with a `preview.requestTimeoutSeconds` timeout; deletions follow in batches of `preview.uploadBatch`. Each batch is recorded as unverified before it is sent, so a write whose reply was lost is sent again by the next sync.
- After each batch Scrat reads the files' `checksumMd5` back and compares it with the MD5 of the bytes it sent (a deleted file must be gone). Any mismatch or Shopify error marks the preview unavailable for that head, with the files listed; it is never shown as current. The next review sends the files that did not verify again.
- The preview is linked on the PR twice. One sticky comment, marked `<!-- scrat-preview -->` and edited in place, carries `https://<publicHost>/?preview_theme_id=<theme id>`, the theme's name and ID and the synced head, or the reasons it is unavailable. Each sync first marks the PR's earlier deployments inactive (one GitHub no longer has counts as inactive), then creates a GitHub Deployment of the head in environment `shopify-preview`, with status `success` and that URL as `environment_url` ("View deployment"), or `failure` when the preview does not match. A repeated sync with the same outcome creates no new deployment. A deployment failure, such as an App without `deployments: write`, is logged as `storefront.deployment_failed` and leaves the comment in place. A sync that fails part way, or finds the theme gone, says so in the comment and a failure deployment, and the next review retries it.
- A review agent whose manifest lists `storefront` in `files` gets `storefront.json` with the preview URL (`null` while the preview is unavailable), numeric theme ID, synced head, whether the preview matches it, the problems and the live URL `https://<publicHost>/`, written only when the preview was synced to the reviewed head, plus the site map as `files.siteMap` (`site.md` beside it) when one has been stored.
- Human-authored PRs get no preview, since their code would run on the store's domain.
- When the PR is merged or closed, the closed-PR cleanup that runs on every sync reads the theme and deletes it, marks every deployment of the PR inactive, edits the comment to say the preview was removed and marks the row deleted, so a PR closed while Scrat was down is cleaned up on the next sync. A theme that is no longer `UNPUBLISHED` is left in the store and forgotten (logged as `storefront.preview_kept`) instead of deleted. A recorded theme that Scrat finds gone from the store while waiting for it to process, before or during a sync, or at cleanup, is marked deleted, and the next review creates a new one.
- Scrat writes only to unpublished themes it created and recorded, duplicates only `MAIN`, reads `MAIN` otherwise only to copy a reverted file back, and never publishes a theme. The Loggie policy cannot tell Scrat's themes from the team's, so this guard is Scrat's own.
- Previews never fail a review. A refused or failed Loggie call is logged as `storefront.preview_failed` (`storefront.delete_failed` during cleanup) and the review goes on; the next review or sync tries again. A stopping service ends the wait without logging a failure. Each Loggie request is logged as a `storefront.loggie` operation with the store and the GraphQL root field (`request`, for example `themeDuplicate`), and creations, adoptions and deletions as `storefront.preview_created`, `storefront.preview_adopted` and `storefront.preview_deleted`, and a failed sync's comment update as `storefront.link_failed`.
- Disabling the storefront also pauses the cleanup. Previews of PRs closed while it was off are deleted on the first sync after it is turned back on.

The site map is the agent's own description of the store, so pages and journeys are discovered, not configured:

- While `storefront.enabled` is true, each poll of the service checks the site map. The map is due when none has been stored, the stored file is missing, it is older than `storefront.siteMapMaxAgeDays`, the discovery skill's text differs from the one that wrote it (a map stored before Scrat recorded the skill counts as different, so it is rediscovered once), or the base branch, as last fetched by the GitHub sync, adds or deletes a path matching `storefront.siteMapPaths` relative to the commit the map was made from (a modified file or a store-admin change does not count; a rename is a delete plus an add). Scrat then queues one `storefront_discover` task (trigger `{ source: storefront, kind: site_map }`) on a `window` subject keyed `storefront_discover:<date of the map it replaces>` (`none` for the first), so each stale map is replaced by one task; the task's reason says why (for a structure change, the path and the two commits). While that subject's latest task is queued or running nothing more is queued. One that runs while `storefront.enabled` is false (queued before it was turned off) is refused before the agent starts. When the latest task failed for good, was refused, or returned `SCRAT_STATUS: incomplete` (it could not read the sitemap or the home page; such a result is never stored), the poll queues a new task on the same subject once `storefront.siteMapRetryHours` have passed since it finished, its reason ending `retrying after <hours> h`; until then the previous map (or none) stays in use. Its manifest's `retry` handles provider outages within a task.
- The session is a read-only review of the base branch with the storefront browser, `storefront.json` holding the live URL, and the previous map as `files.siteMap` when there is one. Its skill (`skills/storefront_discover/SKILL.md`) has the agent read `sitemap.xml` and its child sitemaps, visit enough pages to tell each template apart, and return one line per page or page type with its URL pattern, an example, its purpose, the template that renders it and the interactions that matter, plus a purchase path.
- The `site_map` effect stores the final response as `data/storefront/site.md` under Scrat's directory (not in config and not in the repository), headed with the live URL and the time it was written, and records that time, the SHA-256 of the skill file the run used and the base-branch commit it mapped, separated by spaces, in `source_cursors` (action `storefront_discover`, branch `site_map`). Later storefront sessions receive it as `files.siteMap`. A disabled `storefront_discover` keeps the stored map but never refreshes it.

`review_pr` lists `storefront` in `files` and `browser` in `tools`; both are inert unless the review has a storefront context with an available preview:

- When a review of a Scrat PR finds its preview synced to the reviewed head and matching it, each panel reviewer and the consolidator gets the storefront browser, `storefront.json` with `devices`, `confirmationRuns` and `regressionMaxGrade` added, the site map, and the skill's Storefront section (`{{#storefront}}` ... `{{/storefront}}` in `skills/review_pr/SKILL.md`, removed from every other session's prompt). The section has the agent verify the claimed fix on the preview, compare the purchase path and the pages the diff plausibly touches on preview and live at every device, check the served `themeId` on every theme-rendered preview page (checkout is exempt), look at screenshots with `read`, re-run each candidate regression `confirmationRuns` times after `reset`, and report which pages it checked and why, what it verified, what it could not, unconfirmed candidates and each confirmed regression with screenshot paths. It never submits a form that sends data to the store, enters customer details or payment, or places an order, since the preview runs on the production store. Coverage gaps (a preview bar in the way, a 429, a challenge, settings drift, an exhausted budget) are not defects.
- A graded storefront review ends with `SCRAT_STOREFRONT: verified|regression|unavailable` immediately before `SCRAT_GRADE`, parsed like the grade (a quoted or misplaced line is report text, an unknown value is a format error) and kept out of the comment; the value is saved on the run's result. A complete review without it, or `regression` with a grade better than `storefront.limits.regressionMaxGrade`, is a format error sent back into the same session (the `harness.corrections.format` budget) with the cap spelled out, so the published text and the grade label agree. Once an answer in the session said `regression`, a corrected answer that drops it is a format error too, so the cap cannot be dodged by changing the result. `unavailable` and `verified` leave the grade to the rubric; `verified` means the preview was checked and no regression confirmed, and a fix the preview disproves is a rubric finding. The reviewers' own grades are not capped; the consolidated one is, and the consolidator sees each review's storefront result next to its grade and re-runs only the regressions and fix claims they report or disagree on.
- A base-only re-review (only main moved) does not browse the preview: it gets no browser, no `storefront.json` and no Storefront section, and carries the earlier storefront findings forward.
- A preview that does not match the head still writes `storefront.json` (`available: false`) but gives no browser and no section. Human PRs have no preview, and a disabled storefront gives every review the unchanged skill and tools.
- Screenshots stay in the run's context directory, `data/runs/<run-id>/`; the PR gets the text and the paths.

The agent has no path to Loggie: no tool, no binding and no environment variable reaches its session, and its input never contains the proxy address or the key. The environment allowlist keeps `LOGGIE_API_KEY` out of workspace commands, hooks and the agent's Bash, and the sandbox keeps them from reading it elsewhere. Registering it as a secret adds redaction from logs and errors and the refusal to publish content that contains it.

| Setting | Purpose |
| --- | --- |
| `storefront.enabled` | Turns preview themes on; `false` by default. |
| `storefront.store` | The store's `myshopify.com` host, logged with every Loggie request. Required when enabled. |
| `storefront.publicHost` | The storefront host used in preview links, `https://<publicHost>/?preview_theme_id=<id>`, and as the live URL, without a scheme or path. Required when enabled. |
| `storefront.model` | The model (`provider`, `model`, `thinkingLevel`) of the storefront review session after a main change; the triggering action's model when unset. Validated at startup while the storefront is enabled. |
| `storefront.siteMapMaxAgeDays` | Age after which the stored site map is rediscovered. |
| `storefront.siteMapRetryHours` | Hours after a discovery failed or was incomplete before the next one is queued for the same map. |
| `storefront.siteMapPaths` | Regular expression for the repository paths whose addition or deletion on the base branch makes the site map due; default `^(templates\|layout)/`. Modifications do not count, since theme-editor saves change template JSON several times a day. |
| `storefront.auditPaths` | Paths on `https://<publicHost>` (each starting with a single `/`, default none) that every scheduled store audit visits besides one page of each site-map page type and the purchase path. |
| `storefront.screenshotRetentionDays` | Age in days after which each poll deletes a run's `data/runs/<run-id>/screenshot-*.png` files; baselines under `data/storefront/baselines/` are kept. |
| `storefront.limits.browsers` | Maximum storefront browser sessions open at once per install; a session that would exceed it waits for a free one (logged as `storefront.browser_waiting` with its `position`, then `storefront.browser_started`) and gives up when the service is stopping. A session holds its slot from Chromium's launch until its agent session ends or the budget halts it. |
| `storefront.limits.browserSteps` / `storefront.limits.browserSeconds` | Storefront browser actions allowed per agent session, and the session's browser time. |
| `storefront.devices` | Viewport presets (names from `tools.browser.viewports`) a preview review compares preview and live at, and that the main-branch storefront review screenshots each page at and keeps baselines for; startup fails on an unknown name. |
| `storefront.limits.confirmationRuns` | Fresh-browser re-runs a candidate regression, or a breakage found on main, must reproduce in before the reviewer counts it; 0 counts it on first sight. |
| `storefront.limits.regressionMaxGrade` | Best grade a review with a confirmed storefront regression may publish; `C` by default. |
| `storefront.lighthouse.runs` | Lighthouse runs per page and device (mobile and desktop) after each main change. |
| `storefront.lighthouse.pages` | Paths on `https://<publicHost>` that Lighthouse measures, each starting with a single `/`. |
| `storefront.lighthouse.timeoutSeconds` | Time budget of one main change's Lighthouse runs, counted from when they get a validation slot; runs left when it is spent are reported as not run. |
| `storefront.loggie.url` | Loggie server. Requests go only to `<url>/api/proxy/<slug>/`; redirects are refused, so the key never reaches another host. |
| `storefront.loggie.slug` | The store's Loggie integration slug, as `loggie discover` lists it. Required when enabled. |
| `storefront.loggie.timeoutSeconds` | Timeout of one Loggie request other than an upload batch. |
| `storefront.preview.themeNamePrefix` | Prefix of preview theme names; a PR's theme is `<prefix>pr-<number>`. |
| `storefront.preview.themePaths` | Regular expression for the repository paths that are theme files; other changed paths are not synced. The default matches Shopify's theme directories at the repository root, including `templates/customers` and `templates/metaobject`. |
| `storefront.preview.processingWaitSeconds` | Longest one review waits for a new duplicate to finish processing. |
| `storefront.preview.processingPollSeconds` | Interval between processing checks. |
| `storefront.preview.filesPageSize` | Files per request when listing the whole duplicate theme, at most 250 (Shopify's page limit). |
| `storefront.preview.filenamesPerRequest` | Files per request when reading files by name, at most 50 (Shopify's `filenames` limit). |
| `storefront.preview.uploadBatch` | Files per `themeFilesUpsert` or `themeFilesDelete` call, at most 50 (Shopify's limit). |
| `storefront.preview.uploadBatchBytes` | Encoded bytes per `themeFilesUpsert` call; a file larger than this goes in a batch of its own. Keeps committed build output such as source maps from making one request too large. |
| `storefront.preview.requestTimeoutSeconds` | Timeout of one upload batch, which may carry several multi-megabyte assets, and of downloading a live file's URL body; other Loggie requests use `storefront.loggie.timeoutSeconds`. |


### Main-branch storefront review

While `storefront.enabled` is true, every review of `github.baseBranch` by a commit manifest that publishes `slack_reply` (`review_base_change`) gets a storefront part once the code review has completed. While the storefront is disabled none of it runs and the reply is unchanged.

1. **Live theme proof.** Scrat reads the live `MAIN` theme's `checksumMd5` for the changed paths that match `storefront.preview.themePaths` and compares each with the MD5 of the file at the reviewed commit, comparing the live file's bytes when Shopify gives no checksum; a file the commit deletes must be absent. Any difference means Shopify has not deployed the commit yet (its GitHub sync can lag the push): the differing paths are logged as `storefront.live_mismatch`, the reply says `the live theme does not match <sha> yet`, and nothing else runs. A change that touches no theme files still gets the full review of the live store as it is.
2. **Visual and functional review.** A second read-only session (`skills/review_storefront/SKILL.md`, on `storefront.model`) gets `read`, `grep`, `find`, `ls`, `git` and the storefront browser (see Scoped tools), the changed paths, the live URL, `storefront.devices`, `storefront.limits.confirmationRuns`, the stored site map as `files.siteMap`, the previous run's screenshots as `files.baselines` (copied into the run's directory, each with the commit it was taken on) and the breakages still open from earlier runs. It stays on the store's host, adds nothing to the cart and submits no form other than search. It picks the pages the change plausibly affects and the purchase path, screenshots each page at each device before interacting, compares with the baselines when it has them (a first run, or one with no earlier clean run, has none, and that is not a coverage gap), closes dismissable promo and consent overlays and carries on, and reports a failure as a breakage only after it repeats in fresh browsers, as a `SCRAT_ISSUE` block with a fingerprint. It ends with its own `SCRAT_VERDICT`, which reflects findings rather than coverage: `concerns` is an unexplained change, a failure that did not repeat, or a changed page that could not be checked at all; coverage gaps elsewhere do not lower it. Its Pi session is recorded in the run's storefront result; the run's `piSessionId` and `piSessionFile` stay the code review's.
3. **Baselines and alerts.** When the storefront verdict is `clean`, the first screenshot of each page on `publicHost` at each device in `storefront.devices` becomes `data/storefront/baselines/<page-key>/<device>.png` (the key is the URL path), with its commit in `data/storefront/baselines/index.json`, and pages that run did not capture are dropped; any other verdict keeps the old baselines. Breakages are stored in `data/storefront/alerts.json` with the commit that first reported them. One whose fingerprint is already there is shown as still broken rather than new, and a completed review with none clears the file.
4. **Lighthouse.** Each audit runs in its own Node process (so its memory is released when it ends and a Lighthouse failure cannot take the worker down), with the Chromium the browser tool uses (each run launches it with `--remote-debugging-port` on a free local port), `storefront.lighthouse.runs` runs per page of `storefront.lighthouse.pages`, mobile (Lighthouse's default settings) and then desktop (its `desktopConfig`), measuring the Performance, Accessibility, Best Practices and SEO scores and the First Contentful Paint (FCP), Largest Contentful Paint (LCP), Total Blocking Time (TBT), Cumulative Layout Shift (CLS) and Speed Index metrics (a run missing any of them counts as failed). The runs hold one validation slot (`harness.maxConcurrentValidations`). When `storefront.lighthouse.timeoutSeconds` runs out, the run in progress is abandoned (its Node process is stopped and its Chromium closed), and the rest are reported as not run. Each run's report, without the full-page screenshot, is kept as `data/runs/<run-id>/lighthouse/<device>-<page number>-<run>.json`. Each device's average over its successful runs is compared with the previous main run's average in `data/storefront/lighthouse.json` (per device: the commit, the scores and the metrics, which an older file may lack, in which case only the scores are compared), which it then replaces. This Chromium has no request routing: unlike the storefront browser it does not refuse hosts that resolve to private addresses, which is accepted for now.

The state files are written to a temporary file and renamed. One that cannot be parsed is logged as `storefront.state_unreadable` and read as empty, except `alerts.json`: while it is unreadable, every breakage counts as already reported, so a damaged file never re-alerts them all.

The storefront part never fails the code review: a Loggie, agent or Lighthouse failure is logged as `storefront.review_failed` and shown in the block. Storefront parts of concurrent reviews run one at a time, since they share the stored state.

The block is its own message in the review's Slack thread, posted after the review reply: the session's first line, at most five lines for changed pages, one per breakage, one per Lighthouse device and a link to the GitHub report. Both replies are Block Kit messages with the same content as their plain `text` (the notification fallback, shown below): the lines are a rich text block with real bullets, the Lighthouse averages are a table block (one column per device with a result and one row for the run count, each score and each metric, deltas in the cells, a note when there is no previous run; a device without a result keeps its bullet), and the report link is its own section.

```
*Storefront* on 1a2b3c4: The home page shows the new hero; nothing else changed.
• `/` desktop and mobile: a hero section sits above the collection grid, as the commit intends.
• New breakage `product:variant-picker`: The variant picker does nothing on mobile
• Lighthouse mobile (2 runs): Performance 62 (-3), Accessibility 90 (±0), Best Practices 96 (±0), SEO 100 (±0); FCP 1.8 s (-0.2), LCP 3.1 s (+0.4), TBT 210 ms (±0), CLS 0.05 (±0.00), Speed Index 2.9 s (-0.1)
• Lighthouse desktop (1 of 2 runs): Performance 92 (+2), Accessibility 95 (±0), Best Practices 100 (±0), SEO 100 (±0); FCP 0.9 s (±0.0), LCP 1.6 s (-0.1), TBT 40 ms (±0), CLS 0.01 (±0.00), Speed Index 1.2 s (±0.0)
<https://github.com/<owner>/<repo>/commit/<sha>#commitcomment-<id>|Full storefront report>
```

The Lighthouse table in the same message, with the mobile column as the example above:

| Lighthouse | Mobile | Desktop |
| --- | ---: | ---: |
| Runs | 2 | 1 of 2 |
| Performance | 62 (-3) | 92 (+2) |
| Accessibility | 90 (±0) | 95 (±0) |
| Best Practices | 96 (±0) | 100 (±0) |
| SEO | 100 (±0) | 100 (±0) |
| FCP | 1.8 s (-0.2) | 0.9 s (±0.0) |
| LCP | 3.1 s (+0.4) | 1.6 s (-0.1) |
| TBT | 210 ms (±0) | 40 ms (±0) |
| CLS | 0.05 (±0.00) | 0.01 (±0.00) |
| Speed Index | 2.9 s (-0.1) | 1.2 s (±0.0) |

The full report is a commit comment on the reviewed commit, marked `<!-- scrat-storefront -->` and edited in place when the commit is reviewed again: the proof, the session's report (what it checked and why, page by page), the confirmed breakages, the Lighthouse averages (the same table) and every run's scores, metrics and report path, and the screenshot paths with what happened to the baselines. It is posted with the `contents: write` permission set (or the PAT) just before the block. A failed comment is logged as `storefront.report_failed` and the block is posted without the link. Each message has its own receipt, so a retried publication posts neither again. Screenshots stay on the VM; GitHub gets their paths.

The reaction counts the storefront: it shows the worse of the code review's verdict and the storefront's. Only a new breakage makes the storefront `breaking`; a `breaking` verdict without a new breakage, including one first reported on an earlier commit, counts as `concerns`, so a broken store raises one red alert per fingerprint rather than one per commit. A code review without a verdict still gets no reaction.

Lighthouse is an optional peer dependency (`lighthouse`) loaded lazily. Startup fails when the storefront and a manifest (`review_base_change` or `store_audit`) that publishes `slack_reply` are enabled and `lighthouse`, `playwright-core` or Chromium is missing. The install-root command above installs it with Playwright.

### Scheduled store audit

`store_audit` (ships `enabled: false`) audits the live store once a day, independent of any commit, and reports it in Slack for people who do not read GitHub. It is a `schedule` manifest (`cron: "15 13 * * *"`, `window: 1d`, UTC, so 09:15 US Eastern in winter and 08:15 in summer; the time for an install is set with `cron` under `actions.store_audit` in `scrat.local.json`, and changing it re-seeds the schedule from the next poll) with `files: [storefront, history]`, `tools: [read, grep, find, ls, browser]` and `publish: [slack_reply]`. Startup fails when it is enabled and `storefront.enabled` is false, `channel` is empty, or `SLACK_BOT_TOKEN` is missing; it needs no `startMessage` or `branch`. It also needs the site map: it is useful only after `storefront_discover` has stored one.

- **What it checks.** One read-only session on the manifest's own `model`, with the storefront browser, `storefront.json` (`liveUrl`, `devices`, `confirmationRuns`, `auditPaths` and `knownBreakages` from the audit's own alerts), the site map as `files.siteMap`, the audit's previous baselines as `files.baselines`, and its earlier reports as `files.history`. Its skill (`skills/store_audit/SKILL.md`) picks one URL for each page type of the site map, every path in `storefront.auditPaths` (default none) and the purchase path, screenshots each at every device in `storefront.devices` before interacting, and compares with the baselines. Per device it adds one product to the cart and opens the cart and the checkout, and stops there: it enters no customer details, signs in or submits no other form. Failures are confirmed with fresh browsers like the main-branch review. The verdict is `clean` when every page loaded and the cart and checkout worked, `concerns` for a failure that did not repeat or a must-check page that could not be reached, and `breaking` for a confirmed breakage.
- **Slack.** The agent's first output line is the opening message, posted to the manifest's `channel` (and nothing else is posted before the audit ends); its shape comes from the `rootInstructions` setting, which is put into the prompt (by default one plain sentence on how the store is doing, how many pages were checked and how many problems were found). The thread gets one reply: at most five bullets for changed or failing pages, one per breakage (`New breakage` or `Still broken since`), one per Lighthouse device, and the Lighthouse table with the change since the previous audit. It has no GitHub link. Scrat then reacts on the opening message with the verdict, as for a main-branch change. A retry after a Slack failure posts no second opening message or reply: the reply is recorded in `slackReplyTs` and `storefrontReplyTs` together. The first line cannot mention Lighthouse, which runs after the agent; the reaction is the authoritative verdict.
- **Report and state.** The full report is written to `data/storefront/audits/<tick>.md` (the tick is the window end, for example `2026-10-21T09:00:00.000Z`). The audit keeps its own state under `data/storefront/audits/`: `lighthouse.json`, `baselines/`, `alerts.json`. It records Lighthouse against the base branch tip without the live-theme proof, replaces its baselines only on a `clean` audit, and compares with the previous audit, not with the last main-branch review, which keeps `data/storefront/` itself. The Lighthouse part takes the same lock as the main-branch storefront part, so the two never run together.
- **Override points** (`scrat.local.json`, under `actions.store_audit`): `enabled`, `cron` and `window`, `channel` (required), `rootInstructions`, `browserSteps` and `browserSeconds` (the audit's browser budget, 200 actions and 2700 seconds by default, instead of `storefront.limits.browserSteps` and `browserSeconds`; they must fit in `harness.agentTimeoutSeconds`), `model`, `priority`, `retry`, and the usual `skill`. `storefront.auditPaths` adds paths to every audit, each starting with a single `/`.
- **Analytics.** Adding to the cart and opening the checkout fire the store's analytics and ad pixels (`AddToCart`, `InitiateCheckout`), once per device per audit, plus once more for each confirmation run of a cart or checkout failure, so four events a day with the default devices when nothing fails.

```json
{ "actions": { "store_audit": { "enabled": true, "channel": "C0123456789" } }, "storefront": { "auditPaths": ["/pages/about"] } }
```

### Shopify admin changes

`review_store_change` (ships `enabled: false`) turns edits made in Shopify admin into a live storefront review in Slack. Theme files are not covered here: `review_base_change` reviews them through git. Its trigger is `{ source: shopify, kind: store_change }`; the source polls only while `storefront.enabled` and the action are enabled, and turning the action off deletes its state under `data/storefront/changes`.

- **What it watches.** Products (title, handle, status, publication, description, template suffix), collections (the same, plus image, with no publication check; not membership), pages (title, handle, body, template suffix, publication), menus (the item tree), shop metafields and metaobjects. Articles are not watched. Metafields are limited to the keys the theme names: every `metafields.<namespace>.<key>` found by `git grep` in `*.liquid` and `*.json` at the tip of the base branch, plus `storefront.changes.extraMetafields`, minus `storefront.changes.ignoreMetafields` (all as `namespace.key`). App metafields such as reviews are therefore ignored unless the theme reads them. Metaobject types come from `metaobjectDefinitions`, minus those matching `storefront.changes.ignoreMetaobjectTypes`.
- **Visibility.** A product counts only while it is ACTIVE and published, a page only while published; collections, menus, shop and metaobjects always count. A change is reported only if the resource was visible before or is visible after the poll, so edits to drafts and unpublished pages are ignored, becoming visible is a change, and becoming invisible carries the 404 note.
- **How it detects changes.** Shopify timestamps change without content changes, so each poll (at most every `pollMinutes`) reads the watched fields, hashes them and compares with the snapshot in `data/storefront/changes/snapshot.json`. The first poll saves the snapshot and queues nothing, as does a newly watched metafield key and the first successful read of metaobjects. Each change records the resource, handle, field, the before and after values (clipped to `valueBytes`) and the Shopify admin log lines (`events`) for the resource, which name the staff member. Changes wait in `data/storefront/changes/state.json` until no new change has arrived for `quietMinutes`; then the batch is written to `data/storefront/changes/batches/<time>.json` and one task is queued.
- **What it reviews.** A product, collection or page change maps to its `/products/<handle>`, `/collections/<handle>` or `/pages/<handle>`; menus and shop metafields map to the home page and `storefront.auditPaths`; a metaobject maps to the products, collections and pages whose watched metafields reference it, or site-wide when none do. At most `maxPages` pages are listed. A product that became draft or unpublished is recorded as expected to return a 404. The agent gets the batch as `files.storeChanges`, the storefront browser, `storefront.json`, the site map and the baselines of the main-branch review (`data/storefront/baselines`, merged with the pages this run reviewed rather than replaced), and judges each visible difference against the recorded change. Lighthouse is not run.
- **Slack.** The first message in the channel is the change summary (for example "Store data update in Shopify admin: product `a-shirt` had `custom.details` edited (Jane Doe updated product A shirt)."), and the review is posted as the reply with the verdict reaction on the summary. No GitHub comment is made.
- **Metaobjects.** Reading metaobjects needs the `read_metaobjects` scope on the Loggie Shopify connection. Until the store owner approves it, Shopify answers `ACCESS_DENIED` (or Loggie `SCOPE_UPGRADE_REQUIRED`); the source logs one warning per poll and watches everything else, and the first successful read seeds silently.
- **Loggie access.** The `storefront.loggie` profile needs read access to these Admin GraphQL queries: `products`, `collections`, `pages`, `menus`, `shop { metafields }`, `events`, and `metaobjectDefinitions` and `metaobjects` once the scope exists. It does not use `nodes(ids:)` or `currentAppInstallation`.
- **Settings** (`storefront.changes` in `scrat.config.json`): `pollMinutes` (5), `quietMinutes` (10), `valueBytes` (2048), `maxPages` (12), `summaryEvents` (3), `pageSizes` (`products` 100, `collections` 100, `pages` 100, `menus` 50, `metafields` 250, the per-connection maximum, since metafields are filtered server-side by the watched keys, `shopMetafields` 100, `metaobjectDefinitions` 250, `metaobjects` 50, `events` 50), `extraMetafields` and `ignoreMetafields` (none), and `ignoreMetaobjectTypes` (`^(shopify|app)--`).

```json
{ "actions": { "review_store_change": { "enabled": true, "channel": "C0123456789" } } }
```

### Cloudflare Workers issues

For a repository that deploys Cloudflare Workers, Scrat can file each production issue that Cloudflare's [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) groups (uncaught exceptions, failed invocations, 5xx responses, error-level logs) as a GitHub issue, so that `review_issue` investigates it and the normal `scrat` label flow can lead to `implement`. It is opt-in and off by default: while `cloudflare.enabled` is `false` Scrat loads no Cloudflare code, makes no call and writes no context file.

```json
{ "cloudflare": { "enabled": true, "accountId": "0123456789abcdef0123456789abcdef", "loggie": { "slug": "cloudflare" }, "services": ["api", "web"] } }
```

Scrat polls the Issues API; it has no inbound endpoint, and Cloudflare's push Automations are not used. Access goes through Loggie's HTTP proxy like the storefront (`GET|POST <loggie.url>/api/proxy/<loggie.slug>/accounts/<accountId>/workers/observability/...` with `x-api-key: $LOGGIE_API_KEY`), through the same request path as the storefront's GraphQL calls (key header, timeout, `LOGGIE_*` error codes, `cloudflare.loggie` operation log). Scrat holds no Cloudflare token and the agent gets no Cloudflare tool, binding or environment variable. `cloudflare.loggie` is separate from `storefront.loggie`, so one install can use a different integration slug for each. Startup fails when `cloudflare.enabled` is true and `LOGGIE_API_KEY`, `cloudflare.accountId`, `cloudflare.loggie.slug` or `cloudflare.services` is missing or empty, or `cloudflare.loggie.url` is not an absolute URL.

- **The poll.** Each service poll (the existing cadence, after the GitHub sync) lists the service's `active` issues, newest `lastObserved` first, `cloudflare.issues.pageSize` per page, and keeps those whose type is in `cloudflare.issues.types`. It fetches an issue's occurrences only to file an issue or to test a recurrence. A failed Cloudflare call is logged (`cloudflare.list_failed`, `cloudflare.issue_failed`) and retried on the next poll.
- **Persistence.** Each Cloudflare issue id maps to its GitHub issue number in `source_cursors` (action `cloudflare_issues`, branch the Cloudflare issue id), with the last `count`, `lastObserved` and `updated` seen, so a restart never files an issue twice. Before its first filing in a round, Scrat lists the repository's open issues once and adopts a bot-authored one already carrying the issue's marker, which covers a lost `createIssue` response or a crash before the mapping was saved. An issue whose Cloudflare `count`, `lastObserved` and `updated` have not changed is skipped without any lookup.
- **Filing.** Harness code, no agent turn. An unmapped issue whose `count` reaches `cloudflare.issues.minOccurrences` becomes a GitHub issue titled `<service>: <title>` (cut to GitHub's 256-character limit), labelled `cloudflare.issues.label`, ending with the `<!-- scrat-fingerprint:cloudflare:<id> -->` marker. The body lists the service, type, count, first and last seen and the Cloudflare dashboard link (`https://dash.cloudflare.com/<accountId>/workers/services/view/<service>/production/issues`), then a code block with the latest occurrence's Worker version, `error.name`, mechanism, `handled`, message and the top `cloudflare.issues.stackFrames` stack frames. That text comes from production traffic, so it is fenced as untrusted data and passed through `redactSecrets` and `assertPublishable`. The body is never edited afterwards (an edit would make `review_issue` review the issue again); the context file carries the live counts. While `cloudflare.issues.maxOpen` filed issues are open, further issues wait and the poll logs `cloudflare.issue_deferred`. `log` issues are filed only when `types` lists `log`.
- **Recurrence.** A reopened issue is not reviewed again (bot comments are not part of an issue's review revision, and a labelled issue keeps its completed `implement` task), so a recurrence is filed as a new issue. When a filed issue was closed as completed and Cloudflare saw a newer occurrence, Scrat pages the issue's retained occurrences (`cloudflare.issues.pageSize` per request, stopping on an empty page) and counts it as recurred only if an occurrence after `closed_at` comes from a Worker version (`worker.scriptVersion.id`) that produced no retained occurrence before `closed_at`; the old version failing between a fix merging and its deploy is not a recurrence, and when no pre-close occurrence is retained (Cloudflare keeps them 7 days) any post-close one counts. The pre-close version set is stored in the mapping at that first check, so later rounds read only occurrences newer than the last `lastObserved` and the set cannot expire out of retention; a recurrence deferred by `maxOpen` is kept in the mapping and filed when room appears. The new issue goes through the same filing path (label, marker, `minOccurrences`, `maxOpen`) and its body starts with `Recurred after #<old> was closed on <date>; first seen again in Worker version <id>.` (the oldest unseen version after the close); the mapping then points at it. The old issue is neither reopened nor commented on. An issue closed as not planned stays closed. A filed issue that no longer exists in the repository (deleted or transferred) is filed again at the Cloudflare issue's next occurrence. Open, closed and reason come from the issue payload the GitHub sync stores (`state_reason`, `closed_at`), so the check adds no GitHub reads.
- **Context file.** `cloudflare` in a manifest's `files` (shipped on `review_issue` and `implement`, issue triggers only) writes `cloudflare.md` for a run on a bot-authored issue ending in a `cloudflare:<id>` marker (or, failing that, one the mapping points at): the issue as Cloudflare now reports it and its latest `cloudflare.context.occurrences` occurrences with `error` (full stack, frames as uploaded: a Worker without source maps shows bundle positions), `trail`, `worker` and `invocation` with the query string removed from `url` and `path` and `mailFrom` and `rcptTo` dropped, plus up to `cloudflare.context.logEvents` telemetry events of each occurrence's trace (a dry `POST telemetry/query` on `$metadata.traceId` within `cloudflare.context.logWindowSeconds` of the occurrence). `request` (headers) and `context` (user, account, session) are dropped. Everything passes through `redactSecrets`, is framed as untrusted, and is cut to `cloudflare.context.maxBytes`. Cloudflare keeps occurrences for 7 days; once they are gone, or a request fails (logged as `cloudflare.context_*_failed`), the file says so and keeps the summary, and the run goes on.

| Setting | Default | Purpose |
| --- | --- | --- |
| `cloudflare.enabled` | `false` | Turns the source and the context file on. |
| `cloudflare.accountId` | none | The Cloudflare account. Required when enabled. |
| `cloudflare.loggie.url` / `.slug` / `.timeoutSeconds` | `https://app.loggie.ai` / none / 30 | Loggie proxy address, the integration slug (required when enabled) and the request timeout. |
| `cloudflare.services` | `[]` | Worker script names to watch. Required non-empty when enabled. |
| `cloudflare.issues.types` | `["exception"]` | Issue types to file (`exception`, `log`). `log` is opt-in because error-level operational logs are mostly noise. |
| `cloudflare.issues.minOccurrences` | 5 | An issue is filed once its count reaches this. |
| `cloudflare.issues.maxOpen` | 10 | Most auto-filed GitHub issues open at once. |
| `cloudflare.issues.label` | `cloudflare` | Label on filed issues. |
| `cloudflare.issues.pageSize` | 50 | Issues per request when listing a service. |
| `cloudflare.issues.stackFrames` | 10 | Stack frames in the filed issue's body. |
| `cloudflare.issues.bodyBytes` | 16384 | Byte cap on the error text in the filed issue's body, so the whole body stays under GitHub's limit. |
| `cloudflare.context.occurrences` / `.logEvents` / `.maxBytes` | 5 / 50 / 65536 | Occurrences in the context file, telemetry events per occurrence, and the file's byte cap. |
| `cloudflare.context.logWindowSeconds` | 600 | Seconds before and after an occurrence searched for its trace's log events. |

Rollout, scrat host first: keep Issues enabled in the watched Worker's Wrangler config (a Wrangler deploy otherwise turns them off), upload the Worker's source maps so stacks are readable, and give the host a `LOGGIE_API_KEY` in `.env` for a Loggie profile with the Cloudflare integration. The Issues endpoints are undocumented; they pass through Loggie without a catalog entry. Writing back to Cloudflare (marking an issue resolved or ignored when its GitHub issue closes) is not implemented.
