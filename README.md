# dsh-github-reviewer

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that polls configured GitHub repositories for open pull requests and posts automated `COMMENT` reviews. It is a TypeScript port of the GitHub reviewer built into [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge), and it drives every review and `/bot` chat through the **harness agent loop**: one live Agent per PR, one session log per PR, durable through the harness session-persistence seam.

## Features

- Polls configured repositories for open pull requests; draft PRs are skipped.
- Authenticates as a GitHub App: signs RS256 app JWTs and exchanges them for short-lived installation access tokens (cached until near expiry).
- Reviews a PR when it first appears or when its `head.sha` changes; unchanged PRs are tracked in a per-account cursor file and not reviewed again.
- Reads trusted review instructions only from `.github/review_instructions.md` in the base repository (base branch, then base SHA). If the file is missing and `defaultInstructions` is configured, that text is used; otherwise the PR is marked `missing_instructions` and retried only after the head SHA changes.
- **One harness Agent and session per PR.** Reviews and `/bot` chats on the same PR run in the same session, so the loop replays the PR's full conversation history — the model remembers earlier findings and discussions. Sessions persist across restarts through `sessionPersistence` when a provider is mounted, and the reviewer resumes the existing session instead of starting a fresh one.
- Runs the review through the real agent loop: the review system prompt is registered as a `complete` system-prompt section on the PR agent, and the guarded GitHub tools are registered as scoped harness tools, so the loop's logging, checkpoints, and compaction all apply.
- Spawns a fresh per-turn GitHub MCP server (`github-mcp-server`) over stdio, injecting the installation token as `GITHUB_PERSONAL_ACCESS_TOKEN` and the configured web URL as `GITHUB_HOST`.
- Guards every tool call: calls must target the current PR, reads are limited to allowed methods and refs, and writes are limited to the `create` → inline comments → `submit_pending(event=COMMENT)` pending-review workflow.
- Handles comment commands on already-processed PRs: `/review` triggers a re-review, `/bot <message>` continues the PR conversation and posts the reply to the issue thread or the review thread it answered.
- Sanitizes untrusted PR title/body text before prompt placement (HTML comments/hidden attributes, invisible/control characters, markdown image alt text, markdown link titles, GitHub token-like strings).

## Deployment requirements

The plugin injects the harness `agents` and `sessions` services, so the deployment must mount the agent-loop family. A minimal working composition needs at least these rows beside `github-reviewer` (see [cordis.yml.example](./cordis.yml.example) for the full annotated example):

```yaml
- id: llm-deepseek          # some LLM adapter
  name: '@deepseek-ai/dsh-llm-deepseek'
  config: { thinking: enabled, models: [{ id: deepseek-chat, contextWindow: 128000 }] }
- id: agent-spine           # agent loop + system-prompt assembly + tool pipeline
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    agents: [{ id: main, provider: deepseek-official, model: deepseek-chat, cwd: !!js process.cwd() }]
- id: persistence           # restart-safe per-PR sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config: { root: './.sessions' }
```

- **Without `sessionPersistence`**: the reviewer still works, but PR sessions are memory-only — after a restart the loop starts each PR from a fresh session.
- **With `sessionPersistence`**: every turn is checkpointed, and the reviewer resumes the persisted PR session on restart (it never creates a second session for the same PR).
- PR sessions live in the same session store as interactive sessions, so reviews are visible and replayable in the harness session UI.

## Install

```sh
npm install @lingobridge/dsh-github-reviewer
```

Peer dependency: `@deepseek-ai/cordis` (the harness Cordis runtime).

## Configuration

Mount the plugin in the harness `cordis.yml`:

```yaml
plugins:
  github-reviewer:
    config:
      accounts:
        reviewer:
          appId: '123456'
          installationId: '987654'
          privateKeyPath: '/etc/dsh/github-app.pem'
          baseUrl: 'https://api.github.com'      # optional
          webUrl: 'https://github.com'           # optional
          pollIntervalMs: 120000                 # optional, default 2m
          repositories:
            - 'owner/repo'
          provider: 'deepseek'                   # llm provider route
          model: 'deepseek-chat'                 # model id
          review:                                # all optional
            maxToolCalls: 30
            toolTimeoutMs: 30000
            toolResultLimit: 60000
            timeoutMs: 900000
            defaultInstructions: |
              Review this pull request for correctness, regressions, security issues,
              and missing tests. Leave concise inline comments where useful.
          mcp:
            command: 'github-mcp-server'
            args:
              - 'stdio'
              - '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review'
            env: {}                              # optional; GitHub tokens are injected automatically
            cwd: ''                              # optional
          statePath: ''                          # optional; defaults to ./.dsh-github-reviewer/<account>.json
```

Multiple accounts run independent poll loops.

### Config reference

| Field | Default | Description |
|---|---|---|
| `accounts.<name>.appId` | — | GitHub App ID (required) |
| `accounts.<name>.installationId` | — | GitHub App installation ID used to mint installation tokens (required) |
| `accounts.<name>.privateKeyPath` | — | Local PEM private key path for signing GitHub App JWTs (required) |
| `accounts.<name>.baseUrl` | `https://api.github.com` | GitHub REST API base URL |
| `accounts.<name>.webUrl` | `https://github.com` | GitHub web URL and MCP `GITHUB_HOST` value |
| `accounts.<name>.pollIntervalMs` | `120000` | Interval between PR polling passes |
| `accounts.<name>.repositories` | — | Repository allowlist in `owner/repo` form; at least one is required |
| `accounts.<name>.provider` | `deepseek` | Harness LLM provider route for this account's reviews |
| `accounts.<name>.model` | — | Model id used for this account's reviews (required) |
| `accounts.<name>.review.maxToolCalls` | `30` | Tool-call budget for one review turn; the guard rejects further calls |
| `accounts.<name>.review.toolTimeoutMs` | `30000` | Per-tool-call timeout |
| `accounts.<name>.review.toolResultLimit` | `60000` | Maximum tool-result characters returned to the model per call |
| `accounts.<name>.review.timeoutMs` | `900000` | Overall deadline for one turn; the agent is cancelled past it |
| `accounts.<name>.review.defaultInstructions` | — | Fallback instructions used only when `.github/review_instructions.md` is missing from the base repository |
| `accounts.<name>.mcp.command` | — | Command used to start the per-turn GitHub MCP server (required) |
| `accounts.<name>.mcp.args` | — | Arguments for the server; include explicit `--tools=...` (required) |
| `accounts.<name>.mcp.env` | `{}` | Extra MCP server environment variables; GitHub tokens are injected automatically |
| `accounts.<name>.mcp.cwd` | — | Optional working directory for the server |
| `accounts.<name>.statePath` | `./.dsh-github-reviewer/<name>.json` | Cursor state file path |

Misconfiguration fails the plugin at load: missing credentials, invalid repository names, unreadable private keys, and missing MCP command/args all throw during activation instead of silently skipping reviews.

## How it works

### Polling and cursor state

Each account runs its own poll loop (an immediate pass, then every `pollIntervalMs`). Ticks never overlap. For each PR the poller decides:

- New PR or changed `head.sha` → run a review.
- Reviewed or `missing_instructions` PR with an unchanged SHA → poll comments for `/review` and `/bot` commands.

Cursor state is one JSON file per account (`prs` keyed by `owner/repo#number` with the head SHA, terminal status, and comment-check timestamps), written atomically via a temp-file rename.

### Per-PR agent and session

On first contact with a PR, the runner asks the agent registry for an Agent whose session id is derived from the account and PR (`github:<account>:<owner>:<repo>:pr:<number>`):

- If the PR session already exists in `sessionPersistence`, it is **resumed** with the same setup world.
- Otherwise a fresh agent and session are created; the session id is stable, so a later restart resumes the same PR conversation.

The agent setup registers the review world on the unpublished agent context: a `complete` system-prompt section (the review or chat prompt, selected per turn), the four guarded GitHub tools as scoped tool definitions, and a tool restriction that hides **every global tool** from this agent — the model sees only the closed review tool set, mirroring LingoBridge's guarded-only handler. The session log is the durable per-PR history — later turns replay it through the loop, and checkpoints/compaction apply exactly as for interactive sessions.

### Review flow

1. Read trusted instructions from the base repository (base branch, then base SHA) or the configured default.
2. Spawn the per-turn GitHub MCP server with a fresh installation token and `GITHUB_HOST` injected.
3. Arm the turn slot (PR, flow, instructions, live host, guard state) and wake the PR agent with the review user prompt via `agent.followup`.
4. Await `agent.whenIdle()`: the loop drives model steps and tool calls; the guarded tools enforce the review rules on every call.
5. Flush the session to persistence and mark the PR `reviewed` only when the guarded `submit_pending` call with `event=COMMENT` succeeded.

### Tool guards

The four tools (`mcp_github_pull_request_read`, `mcp_github_get_file_contents`, `mcp_github_pull_request_review_write`, `mcp_github_add_comment_to_pending_review`) are registered only on the PR agent's scope, bound to that PR, and the agent scope hides every global tool — other agents never see them, and the review agent never sees global tools:

- `pull_request_read`: only `get`, `get_diff`, `get_files`, `get_status`, `get_check_runs`; must target the current PR.
- `get_file_contents`: base/head repositories only; `sha` must be the current base or head SHA; `ref` must be the base/head branch, `refs/heads/<branch>`, `refs/pull/<number>/head` on the base repo, or one of those SHAs; `sha` and `ref` must not both be set. Omitting both defaults to the head SHA.
- `pull_request_review_write`: `create` must not carry `event`/`body`, `commitID` is validated against (or injected as) the head SHA, and extra fields are dropped; `submit_pending` only with `event=COMMENT`.
- `add_comment_to_pending_review`: relative paths only; `FILE` or `LINE` comments with `line`/`side` and paired `startLine`/`startSide` validation.

Approvals, request-changes reviews, thread resolution, PR updates, merges, and repository writes are rejected before reaching the MCP server. The tool-call budget (`maxToolCalls`), per-call timeout, result truncation, and the turn deadline are enforced by the guard and the runner on top of the loop.

### Trust model

The review system prompt is registered as the agent's complete system prompt and carries trusted instructions only from the base-repo file or the configured default. PR metadata, title/body, diffs, changed files, and tool output are untrusted context; the title/body is sanitized before prompt placement, and the prompt instructs the model not to follow instructions found in untrusted context.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Known Limitations and Deferred Work

- The cursor file is local to the process host; running two hosts against the same account would poll twice. PR sessions are durable through the harness, but review *triggers* are not (LingoBridge keeps both in its per-account store).
- The plugin requires a full agent-loop deployment (`agents` + `sessions`); it no longer activates in bare compositions without them. Without a `sessionPersistence` provider, PR sessions are memory-only across restarts.
- PR sessions share the session store with interactive sessions; they are visible and replayable there, but nothing labels them as reviewer sessions beyond the session id.
- GitHub API rate limits are surfaced as errors and the poll continues on the next tick; there is no backoff beyond the poll interval.
- Comment polling uses the cursor timestamps as the `since` bound, so comments deleted before the next poll are not seen.
