# Scrat

Scrat is a GitHub coding agent built with TypeScript, [Pi](https://github.com/earendil-works/pi), and SQLite. It reviews issues and pull requests, implements selected issues, and maintains its own PRs. Scrat handles scheduling, workspaces, validation, and publication; Pi investigates and writes code.

## How it works

GitHub sync turns repository state into a persistent task queue:

- **PR reviews:** by default two model sessions review independently. A fresh consolidation session combines their findings into one updatable comment and a grade label. This includes Scrat's own PRs.
  A re-review caused only by relevant changes on the base branch, with the PR head and discussion unchanged since the authoritative assessment and no manual request, runs one session with the first configured reviewer and no consolidation. That plan is rechecked against the observed state before inference and falls back to the full panel if it no longer holds; the run's `reviewers` and model fields record which plan ran.
- **Implementation and maintenance:** issues labelled `scrat` become implementation tasks. Conflicts and new external feedback on Scrat-authored PRs become separate repair tasks.
- **Issue reviews:** Scrat assesses issues and applies the `scrat` label when it considers them ready for implementation. Each issue has one assessment comment, which later reviews edit in place; a re-review gets the previous assessment.

Concurrency, priorities, models, and reasoning levels come from configuration. Queued tasks coalesce by item and action; tasks sharing an item or workspace cannot execute together. Bot-authored comments do not trigger feedback tasks. A current review graded C, D or F on a Scrat PR queues one `address_review` repair per assessment (a queued repair is cancelled when its assessment goes stale or human feedback is pending), capped per PR by `maxSelfRepairs`. An `address_review` or `address_pr_feedback` run whose agent changed nothing (same head, no merge in progress, clean tree) skips preparation and validation and publishes its reply directly.

Scrat serves the single configured repository and clone: sync and fetch refuse any other repository, a clone whose `origin` is a different repository is never updated (a clone whose origin is not a github.com URL for the configured repository, such as an ssh host alias, is refused), and queued tasks for items of another repository are rejected at claim.

Implementations use private clones and branches; follow-ups reuse their workspace and Pi session. Checks must pass against the exact tree being committed before publication. Optional Docker PostgreSQL databases isolate mutating runs. PR closure triggers workspace cleanup; failed work is retained for recovery.

Stale branches are brought up to date by merge commit, never rebase. A Scrat PR that is behind its base and failed at preparation (or conflicts) gets a `resolve_conflicts` task: a clean merge is made in code without a model session and validated normally (a validation failure falls back to the agent in the same run), while conflicts go to the agent. Feedback and repair tasks on a behind Scrat PR whose preparation fails merge the base first and ship that merge with their own push. A human-authored PR that cannot be prepared because it is behind, but merges cleanly, is reviewed on a local throwaway merge of its base (the diff stays relative to the base, nothing is pushed or commented); if the merge conflicts, the review fails, Scrat replaces its assessment comment with a note asking the author to update the branch, and that PR is not reviewed again until its head or base branch changes or a review is enqueued by hand.

Repository commands, Git hooks and Pi's Bash receive a minimal inherited environment, never Scrat's credentials. Pi's file tools stay inside the workspace and its run's context directory (`data/runs/<run-id>/`, holding the discussion and larger context outside the worktree). Prompts are small manifests with no patch bodies; read-only sessions inspect changes through a capped, scope-recording read-only `git` tool instead of Bash. Comments, PR bodies and commits that contain configured credentials are refused rather than published.

The newest complete PR assessment is authoritative. Context and observed source/dependency changes determine freshness—a relevance heuristic, not a full dependency graph. Stale assessments lose their grade and require a fresh review; older opinions never regain authority. Publication-only retries reuse saved results. Scrat does not automatically merge PRs.

## Configure and run

Requires Node.js **22.19+**, Git, and the tools used by the target repository's workspace commands. Workspace commands and agents run on Scrat's Node, so the deployment uses the target repository's Node major (24 on the VM). Docker is required when per-run databases are configured.

1. Run `npm ci`.
2. Edit `scrat.config.json`: GitHub repository/App installation, model provider, action skills, concurrency, and workspace preparation/validation commands.
3. Create an untracked `.env` containing `CODEX_LB_API_KEY` and the GitHub credential for the chosen `github.auth` mode: `GITHUB_APP_PRIVATE_KEY` (`"app"`; install the GitHub App on the target repository with the necessary contents, issues, and pull-request permissions) or `GITHUB_PAT` (`"pat"`; see GitHub authentication below). Add `SLACK_BOT_TOKEN` when `review_base_change` is enabled (see Slack status below).
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

## Configuration

`scrat.config.json` controls runtime behavior (deployment overrides: see below). Restart the service after changing it; action settings are captured when a run is claimed, and retries retain their saved settings.

### Deployment overrides

`scrat.config.json` holds the defaults and ships with each release. Settings specific to one deployment go in `scrat.local.json`, a gitignored file next to it that holds only the overrides, for example `{"harness":{"maxConcurrency":8}}`. If it is missing, Scrat creates it containing `{}`.

- Plain objects merge recursively; arrays and primitives replace the default. `null` is accepted only where the schema allows it: `workspace.database` (`"workspace":{"database":null}` disables the database), `workspace.commandMemoryMax`, `workspace.packageStore`, and an action's `exhaustedLabel` or `failedLabel`.
- The merged config is validated against one schema (`src/config-schema.ts`): an unknown key, a wrong type or an out-of-range number stops startup with the setting path, for example `harness.maxConcurency: unknown setting` or `harness.maxConcurrentValidations: must be >= 1`. `workspace.environment` (variable names) and `providers` are open: they accept keys the defaults do not show, so a provider can be overridden or added.
- Relative paths in overrides resolve from the config directory, like the defaults.
- Overrides live in `scrat.local.json`, linked into each release by the installer, which checks it before stopping the service; check an edit with `node src/config.ts`, then restart the service.

Per-install systemd overrides (for example a lower `MemoryMax` than the unit's 20G on a smaller host) go in `~/.config/systemd/user/scrat.service.d/local.conf`. The installer keeps it across deploys; apply an edit with `systemctl --user daemon-reload && systemctl --user restart scrat.service`.

`deploy/install.sh` installs a staged release on the existing worker: it drains the service, backs up SQLite, applies schema updates, and switches to the selected release. It refuses anything but a tagged release: the commit must be the one that its `package.json` version's `vX.Y.Z` tag points to, checked through the GitHub API before the service is touched. It contains host-specific paths, so review it before reuse.

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
| `harness.corrections.incomplete` | Times a review session that returns `SCRAT_STATUS: incomplete` is re-prompted in the same session before the run fails as incomplete; 0 disables. Implementations are never continued. |
| `harness.corrections.validation` | Times the agent is re-prompted in the same session after `workspace.validate` fails; 0 disables. |
| `harness.corrections.format` | Times the agent is re-prompted when its final answer is not in the required result format; 0 disables. |
| `harness.agentRetry` | Retries for a failed model request inside a Pi session: `maxRetries` and `baseDelayMs`; 0 retries fails the request at once. |
| `harness.logTargetChars` | Longest path, pattern, command or revision shown in tool log lines and in the heavy-command refusal message. |
| `harness.logErrorChars` | Longest tool error shown in a `pi.tool_failed` log line. |
| `harness.reviewCacheLimit` / `harness.treeCacheLimit` | Entries kept in the review-relevance cache and the tree-listing cache. |
| `harness.databaseHealthRetries` | Failed health checks, one second apart, before a run's database container is declared unhealthy. |
| `harness.logLevel` | Pino log verbosity, such as `info` or `debug`. |
| `context.inlinePaths` | Most changed paths put inline in the agent's input; beyond it they go to a context file. |
| `context.historyRuns` | How many earlier completed runs of an action feed its `history` context. |
| `context.historyBytes` | Size cap of the `history` context. |
| `relevance.ignoredPaths` | Regular expressions matched against each repository-relative path changed on the base branch, for generated output such as build manifests. A push whose changed paths all match is relevant to no review, and matching paths are left out of the changed paths given to the agent. The default `[]` ignores nothing. |
| `tools.readBytes.default` / `tools.readBytes.max` | Bytes returned by one call of a tool that reads text (the review git tool, `read_base`, the browser's page text) / the cap on its `limit` parameter and on HTTP responses. |
| `tools.git.maxCommits` | Most commits one review git `log` call lists. |
| `tools.git.maxScopeBytes` | Most bytes of file names the review git tool reads to scope a diff. |
| `tools.http.timeoutSeconds` / `tools.http.maxRequestBytes` | Per-request timeout and request body cap of the `http` tool. |
| `tools.browser.steps` / `tools.browser.sessionSeconds` / `tools.browser.stepSeconds` | Browser actions allowed per agent session, session length, and timeout of one action. |
| `tools.search.pageSize` / `tools.search.excerptChars` / `tools.search.maxQueryLength` | Results per `github_search` call, characters of each result's body excerpt, and longest query the agent may send. |
| `tools.redactionMarginBytes` | Extra bytes read beyond a tool's output limit so a secret straddling the cut is still redacted. |
| `slack.enabled` / `slack.channel` | Turn Slack status posting on, and the channel ID to post in (see Slack status). |
| `slack.minimumGapMs` | Least time between Slack posts; 0 posts back to back. |
| `slack.maxRetryAfterSeconds` | Longest `Retry-After` Scrat waits out once on a Slack 429; a longer one drops the post. |
| `slack.maxErrorLength` | Longest run failure message quoted in a Slack status post. |
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

- **App (default).** A GitHub App installation token, minted per repository and per permission set.
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
not a fallback to host execution. The installer checks the boundary before stopping
the old service. On Ubuntu 24.04, an administrator installs `bubblewrap`, installs
`deploy/scrat-bwrap.apparmor` as `/etc/apparmor.d/scrat-bwrap`, and loads it with
`apparmor_parser -r /etc/apparmor.d/scrat-bwrap`. Do not disable the global userns
restriction. Provision Node and the pinned pnpm version with Corepack first.

`workspace.packageStore` (off unless set) is an absolute directory, not a symlink, that is bind-mounted read-write at pnpm's store
location in every sandboxed command, with a `storeDir` entry written to the sandbox home's pnpm `config.yaml` so
pnpm uses it. A lockfile's packages are then downloaded once per install instead of once per workspace. It requires
`workspace.sandbox`, and the installer's preflight writes to it. This is opt-in and meant for repositories whose
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
| `workspace.prepare` | Setup commands, including dependency installation and code generation. Also used for read-only reviews, and rerun before mutating-work validation. |
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

Each action is one manifest, `actions/<name>.yaml`, validated at startup (`src/manifests.ts`): `review_issue`, `review_pr`, `implement`, `resolve_conflicts`, `address_pr_feedback`, `address_review`, and `review_base_change`. A manifest fixes the trigger, mode, acceptance rule, `tools` the agent session gets, context `files`, and publish effects, all from closed lists; an unknown key or value stops startup with the file and path. The settings below are the manifest's deployment-level keys, and `scrat.local.json` overrides them by action name.

| Setting under `actions.<action>` | Purpose |
| --- | --- |
| `priority` | Default queue priority; higher values are claimed first. Manual enqueue can override it. Running tasks are not preempted. |
| `skill` | Prompt file, resolved relative to the config directory. |
| `provider` / `model` | Provider name and model ID for the action. For PR reviews, these select the consolidator. |
| `thinkingLevel` | Requested Pi reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; provider/model support determines its mapping. |
| `reviewers` | PR review panel: exactly two entries, each with its own `provider`, `model`, and `thinkingLevel`. |
| `maxSelfRepairs` | `address_review` only: most self-repair runs started for one PR; 0 disables self-repair; not enqueueable manually. A push makes the review stale and Scrat re-reviews; a reply-only repair is not retriggered for the same assessment. |
| `retry` | Review-mode actions only, optional: `{ initialDelaySeconds, maxDelaySeconds }` (max not below initial). When every reviewer of a review (or its consolidation) fails at the agent stage with a transient provider error that survived Pi's own short retries (classified with `@earendil-works/pi-ai`: context overflow, quota/billing exhaustion, auth and setup errors, incomplete results and agent timeouts are excluded, and one permanent reviewer failure keeps the task failed), the failed run and its error are kept and the task is requeued with exponential backoff: `initialDelaySeconds`, doubled per attempt, capped at `maxDelaySeconds` (the delay is capped, not the attempt count), plus up to `harness.retryJitter` of random jitter. The retry count and next-attempt time are stored on the task; delayed tasks are not claimed until due and hold no worker slot, and the backoff survives restarts. A changed trigger or `npm run enqueue` resets the count and delay, `npm run retry -- <task-id>` on the delayed task makes it due now, and a successful run resets it. The `run.requeued` journal event carries `attempt` and `nextAttemptAt`, and the Slack status shows the time. A review restarted from the start uses the currently configured models and reviewers, not the failed run's, so changing a provider in `scrat.local.json` and restarting rescues delayed reviews. Omitted means no durable retries; `null` in `scrat.local.json` disables a shipped default. |
| `exhaustedLabel` | `address_review` only, optional: label added to a Scrat PR whose current review is graded C or lower once `maxSelfRepairs` is reached, and removed when its current review grades better. `null` or `""` (e.g. in `scrat.local.json`) disables it; GitHub creates the label if it is missing. A repair counts toward `maxSelfRepairs` when it starts running, not when it is queued or cancelled. |
| `failedLabel` | Change-mode actions only, optional (`implement` ships `Scrat failed`): label kept on the issue or PR while the latest task of this action there has failed for good, so `label:"Scrat failed"` lists every stuck item. Sync reconciles it from the database each round and writes only when it changes: the next sync removes it once that task is retried, superseded or cancelled, and restores it if a human removes it while the task is still failed. An interrupted or delayed task is queued, not failed, and is not labelled. `null` or `""` disables it; GitHub creates the label if it is missing. |

### Adding an action

A deployment adds or changes actions without a code release. Set `actions.directory` in `scrat.local.json` to an absolute path outside the release (on the VM, `~/.local/share/scrat-v2/actions`, which the installer creates):

```json
{ "actions": { "directory": "/home/bek/.local/share/scrat-v2/actions", "review_issue": { "enabled": false } } }
```

- Every `*.yaml` directly in that directory is a manifest, loaded after the shipped `actions/*.yaml`. The file name must equal `name` (lowercase letters, digits and underscores; `directory` is reserved). A file whose `name` matches a shipped action replaces that whole manifest, which is how a deployment changes its `tools`, `files`, `context`, `publish` or `trigger`; any other name adds an action.
- Overrides in `scrat.local.json` apply by name after both sets are merged: `enabled`, `priority`, `skill`, `provider`, `model`, `thinkingLevel`, `agent`, `reviewers`, `branch`, `channel`, `maxRangeCommits`, `startMessage`, `maxSelfRepairs`, `exhaustedLabel`, `failedLabel`, `retry`. Everything else (`trigger`, `mode`, `context`, `tools`, `files`, `acceptance`, `start`, `publish`) is structural and changes only by shipping a manifest.
- A relative `skill` resolves against the directory the manifest came from, so a deployment keeps `<directory>/skills/<name>/SKILL.md` beside its YAML. Absolute paths work too.
- Routing picks the action whose `trigger` matches what sync observed: `source` and `kind`, then `item` (`issue` or `pr`), `author: bot` (the item is authored by `github.botLogin`), `grades` (for `low_grade`) and `branch` (the commit branch polled). `manual: false` stops `enqueue` by hand. An enabled match is preferred; a disabled one still queues its task and is refused when claimed.
- Two enabled manifests may not share a trigger: startup fails naming both files. To give a trigger to a new action, disable the shipped one that owns it (`"review_issue": { "enabled": false }` above). The selection label still decides between the `label` and `item_changed` issue triggers.
- `tools` is the list of agent tools (`read`, `grep`, `find`, `ls`, `git`, `read_base`, `bash`, `edit`, `write`) and the scoped tools `http`, `browser` and `github_search` (see Scoped tools below); `review` manifests get no write tools and `change` manifests no `git` or `read_base`. `files` lists the optional context files written for the run (`discussion`, `review`, `previous_assessment`, `previous_repair`, `history`); `history` is opt-in. `publish` lists effects (`push`, `pull_request`, `comment`, `labels`, `pr_assessment`, `issue`, `slack_reply`). In a `review` manifest `comment` keeps one assessment comment per item, marked `<!-- scrat-review -->` and edited in place, and `previous_assessment` then holds the action's last completed assessment; in a `change` manifest each task posts its own comment. An unknown name or key stops startup with the file and path.
- Manifests are read once at startup: restart the service to apply a change. The supervised repository never contributes manifests.

A `schedule` trigger runs a `review` action on a cron expression instead of on a GitHub event. `error_sweep.yaml` in the actions directory sweeps logs every six hours and opens an issue for each problem it reports:

```yaml
name: error_sweep
trigger: { source: schedule, kind: tick, cron: "0 */6 * * *", window: 6h }
mode: review
agent: single
context: all
tools: [read, grep, find, ls, http]
files: [history]
publish: [issue]
skill: skills/error_sweep/SKILL.md
model: { provider: codex-lb, model: gpt-6.1-sol, thinkingLevel: high }
priority: 20
```

- `cron` has five UTC fields (minute, hour, day-of-month, month, day-of-week; 0 and 7 are Sunday), each a `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma list of those. When both day fields are restricted, either one matching is enough. `window` is a number of minutes, hours or days: `90m`, `6h`, `1d`. A schedule manifest must be `mode: review`, and several may be enabled at once.
- Each manifest keeps its own cursor: the next tick. The first poll after enabling records the next tick and queues nothing; disabling deletes the cursor. When a tick is due, Scrat queues one task on a `window` subject keyed `<action>:<tick>` with `start` (the tick minus `window`) and `end` (the tick) in its metadata. Ticks missed while the service was down fire once, for the latest one.
- The agent gets the base branch checked out read-only, the window as `input.start` and `input.end`, and no GitHub issue or PR. List `history` to give it its earlier reports, and `issue` in `publish` to open the problems it finds.
### Scoped tools

No shipped manifest lists `http`, `browser` or `github_search`; a deployment manifest opts in by naming the tool in `tools` and, for the first two, adding the matching setting. Each tool is built only for a manifest that lists it.

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

**`browser`** takes `browser: { navigationHosts: [..], resourceHosts: [..], binding?: <name> }`. The agent calls it with `{ action, url?, selector?, text? }` where `action` is `goto`, `text` or `screenshot` (a PNG saved in the run's context directory, whose path is returned); there is no way to click or type. A fresh Chromium context with no profile is used per run; every request is routed, and one whose host is not allowed is aborted: navigations (documents and frames) need `navigationHosts`, other requests need `resourceHosts` or `navigationHosts`. A binding, when named, adds its header only to requests for the binding's hosts, and the header is removed from requests to any other host. Calls run one at a time, and each agent session (a panel review's reviewers and consolidator, or a validation follow-up, are separate sessions) gets at most `tools.browser.steps` browser actions and `tools.browser.sessionSeconds` seconds, each action bounded by `tools.browser.stepSeconds`; page text is capped at `tools.readBytes.default` characters. Playwright is an optional peer dependency (`playwright-core`) loaded lazily, so deployments without a browser action pay nothing, and startup fails with a clear message when an enabled manifest lists `browser` and the package or Chromium is missing. One-time install on the host:

```sh
npm install --no-save playwright-core
PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/scrat-v2/browsers npx playwright-core install chromium
sudo env PLAYWRIGHT_BROWSERS_PATH=$HOME/.local/share/scrat-v2/browsers npx playwright-core install-deps chromium   # system libraries, once, as root
```

Run the service with the same `PLAYWRIGHT_BROWSERS_PATH`. `npm ci` (run by the installer on each deploy) removes packages installed with `--no-save`, so repeat the first command after each release. Chromium is launched with its sandbox enabled (`chromiumSandbox: true`); if the host cannot support that unprivileged, fix the host rather than disabling it.

When a session's browser starts, each allowed host is resolved and Chromium is launched with `--host-resolver-rules` mapping it to that address (`~NOTFOUND` when it does not resolve); the browser tool refuses the run if any host resolves to a private address. A network namespace with no route to private ranges is the stronger boundary and belongs to the VM deployment, not the code.

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
2. Under OAuth & Permissions, add the bot token scope `chat:write`, then install the app to the workspace.
3. Copy the Bot User OAuth Token (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN=xoxb-...`.
4. Invite the bot to the channel (`/invite @<bot name>`).

The token comes only from the environment, never from `scrat.config.json`. Scrat redacts it from logs and errors, refuses to publish text that contains it, and does not pass it to agents or workspace commands. Startup calls Slack's `auth.test` with the token whenever Slack status or `review_base_change` is enabled, and a failure stops startup. Startup fails when `slack.enabled` is true and the channel or token is missing. Startup does not test posting, so a bot that was never invited is found by the first post, which fails and is logged.

The first update for an item posts a root message with its kind, number, title and link, and the thread is stored so a restart never opens a second one. Changing `slack.channel` starts a new thread in the new channel. Replies cover: a run starting, completing or failing (with the stage and the redacted error), a repair or validation round queued, comments posted or updated, labels added or removed, commits pushed, and issues or pull requests created. A pull request Scrat opens is announced in the thread of the issue it came from. Queueing, coalescing and cancelling are not posted. Messages contain only titles, links, actions, stages, labels and redacted error messages, never command output.

Posting is best effort. It runs after the database write, one message at a time, at least a second apart, and a 429 is retried once after its `Retry-After`. A failed post is logged as `slack.post_failed` and dropped: it never changes a task's outcome, and a failed root is tried again with the next update.

### Base branch review

`review_base_change` reviews each update to `github.baseBranch` and reports the review in Slack. It runs on the `github.fetchIntervalSeconds` interval and at startup. It queues one review per push range by default, or one per commit with `granularity: commit`. Commits can be filtered by `author` or `message` (see `github_commits` above), and Scrat's own merged commits are reviewed unless filtered out.

For each review, Scrat posts `startMessage` to the channel as the opening message, then replies in that thread with the review: a one-line verdict followed by at most five bullets, highest consequence first, and at most 3,000 characters.

The agent receives the commit messages, the changed paths and the diff for the range. It has read-only tools, including `read_base` for the commit before the range. It does not install dependencies, run validation, open a PR or post to Slack, and it never sees the Slack token.

| Setting under `actions.review_base_change` | Purpose |
| --- | --- |
| `enabled` | Ships `false`; set `true` in `scrat.local.json` to turn the action on. |
| `agent` | `single` runs one review session. `panel` runs the two `reviewers` as in PR review, and `provider` and `model` consolidate them into one reply. |
| `reviewers` | Required with exactly two entries when `agent` is `panel`; each takes `provider`, `model` and `thinkingLevel`. |
| `branch` | Branch to watch, the manifest's `trigger.branch` by default; must not be empty. |
| `channel` | Slack channel ID to post in. Required when enabled, and the bot must be a member of it. |
| `maxRangeCommits` | Range granularity: a range with more first-parent commits is recorded as `truncated` and still reviewed whole. Commit granularity: most commits queued per poll. |
| `startMessage` | Opening message template. Variables: `{{sha}}` (tip commit), `{{short_sha}}`, `{{author}}` (commit author name), `{{title}}` (commit subject), `{{url}}`, `{{branch}}`, `{{count}}` (commits in the range) and `{{bot}}` (`github.botName`). Any other `{{name}}` stops startup. |
| `priority`, `skill`, `provider`, `model`, `thinkingLevel` | As in the table above. |

Author and title are escaped for Slack. Messages do not unfurl links or ping users by name.

On the first run after enabling, Scrat records the current tip and reviews nothing. Disabling deletes that record, so enabling again starts from the new tip and does not review the commits pushed while the action was off.

If the recorded tip is no longer an ancestor of the new tip (a force-push), Scrat reviews from the merge base of the two when the old tip is still in the clone. A new tip behind the recorded one, or one with no merge base, starts again from the new tip without a review. These cases are logged as `commits.cursor_rewound` and `commits.cursor_reset`.

Failures:

- Slack is unreachable when the run starts: Scrat logs `slack.post_failed` and runs the review anyway. The opening message is posted with the reply.
- Slack is unreachable when the reply is posted: the run fails at publishing. `npm run retry -- <task-id>` reuses the saved review and posts only the reply to the thread, without running the agent again.
- Slack has no idempotency key. A crash after Slack accepts a message but before Scrat records its timestamp can post that message again on retry, either the opening message or the reply.
