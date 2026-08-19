# dsh-github-reviewer

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/@xinlongwu/dsh-github-reviewer)](https://www.npmjs.com/package/@xinlongwu/dsh-github-reviewer)
[![CI](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@xinlongwu/dsh-github-reviewer)](https://github.com/Xinlong-Wu/dsh-github-reviewer/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@xinlongwu/dsh-github-reviewer)](https://nodejs.org)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that polls configured GitHub repositories for open pull requests and posts automated `COMMENT` reviews. It is a TypeScript port of the GitHub reviewer built into [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge), and it drives every review and `/bot` chat through the **harness agent loop**: one live Agent per PR, one session log per PR, durable through the harness session-persistence seam.

## Features

- Polls configured repositories for open pull requests; draft PRs are skipped.
- Authenticates as a GitHub App: signs RS256 app JWTs and exchanges them for short-lived installation access tokens (cached until near expiry).
- Reviews a PR when it first appears or when its `head.sha` changes; unchanged PRs are tracked in a per-account cursor record in the storage domain and not reviewed again.
- Reads trusted review instructions only from `.github/review_instructions.md` in the base repository (base branch, then base SHA). If the file is missing and `defaultInstructions` is configured, that text is used; otherwise the PR is marked `missing_instructions` and retried only after the head SHA changes.
- **One harness Agent and session per PR.** Reviews and `/bot` chats on the same PR run in the same session, so the loop replays the PR's full conversation history — the model remembers earlier findings and discussions. Sessions persist across restarts through `sessionPersistence` when a provider is mounted, and the reviewer resumes the existing session instead of starting a fresh one.
- Runs the review through the real agent loop: the review system prompt is registered as a `complete` system-prompt section on the PR agent, and the guarded GitHub tools are registered as scoped harness tools, so the loop's logging, checkpoints, and compaction all apply.
- Spawns a fresh per-turn GitHub MCP server (`github-mcp-server`) over stdio, injecting the installation token as `GITHUB_PERSONAL_ACCESS_TOKEN` and the configured web URL as `GITHUB_HOST`. On first contact with a PR it additionally spawns one short-lived MCP server for tool-schema discovery; after that, every turn gets a brand-new server.
- Guards every tool call: calls must target the current PR, reads are limited to allowed methods and refs, and writes are limited to the `create` → inline comments → `submit_pending(event=COMMENT)` pending-review workflow.
- Handles comment commands on already-processed PRs: `/review` triggers a re-review, `/bot <message>` continues the PR conversation and posts the reply to the issue thread or the review thread it answered.
- Sanitizes untrusted PR title/body text before prompt placement (HTML comments/hidden attributes, invisible/control characters, markdown image alt text, markdown link titles, GitHub token-like strings).

## Deployment requirements

The plugin injects the harness `agents`, `sessions`, and `agentDefaultModel` services, so the deployment must mount the agent-loop family. A minimal working composition needs at least these rows beside `github-reviewer` (see [cordis.yml.example](./cordis.yml.example) for the full annotated example):

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
- id: storage               # storage hub (storage-json and storage-domain both depend on it)
  name: '@deepseek-ai/dsh-storage'
- id: storage-json          # cursor storage backend (JSON files)
  name: '@deepseek-ai/dsh-storage-json'
  config: { root: './.storage' }
- id: storage-domain        # cursor storage domain (dsh_github_reviewer)
  name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json }
- id: agent-default-model   # default model selection for every review agent
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: deepseek-official, model: deepseek-chat }
```

- **The model is not plugin-configured**: every review agent uses the deployment's default model selection (`agentDefaultModel`), provided by `@deepseek-ai/dsh-agent-default-model` on its own (config requires `{ provider, model }`), not by the agent-spine family.
- **Unsatisfied dependencies silently deactivate the plugin**: when a cordis dependency is missing, the fiber stays PENDING forever and the plugin never activates — so the `agent-default-model` row and the storage rows (`storage` hub, `storage-json` backend, `storage-domain`) added above are required.
- **The cursor needs the storage domain**: the `dsh_github_reviewer` domain is provided by `@deepseek-ai/dsh-storage-domain`, which needs a backend (`@deepseek-ai/dsh-storage-json` or `@deepseek-ai/dsh-storage-sqlite`) routed in the storage-domain config (e.g. `backend: json` or `backend: sqlite`). The plugin fails loudly at load without it.
- **Without `sessionPersistence`**: the reviewer still works, but PR sessions are memory-only — after a restart the loop starts each PR from a fresh session.
- **With `sessionPersistence`**: every turn is checkpointed, and the reviewer resumes the persisted PR session on restart (it never creates a second session for the same PR).
- PR sessions live in the same session store as interactive sessions, so reviews are visible and replayable in the harness session UI.

## Install

```sh
npm install @xinlongwu/dsh-github-reviewer
```

Peer dependency: `@deepseek-ai/cordis` (the harness Cordis runtime).

### Enabling on a running DSH instance

Assume the instance profile lives at `$DSH_HOME/profiles/web` (`DSH_HOME` defaults to `~/.dsh`) and the composition already includes the storage chain and the agent loop (bundled with the official `dsh-base` + `dsh-web-app`).

**1. Install the GitHub MCP server** (the official Go server; its tool names match the guard):

```sh
# Linux x86_64; substitute the asset name for other architectures
curl -sL https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_x86_64.tar.gz \
  | tar -xz -C ~/.local/bin github-mcp-server
github-mcp-server --version
```

A container works too (`ghcr.io/github/github-mcp-server`); see the commented `mcp` block below.

**2. Install the plugin into the profile**:

```sh
cd "$DSH_HOME/profiles/web"
# Add to dependencies in package.json:
#   "@xinlongwu/dsh-github-reviewer": "^0.1.0-rc2"
npx pnpm install
ls node_modules/@xinlongwu/dsh-github-reviewer/lib/index.js   # confirm the install
```

**3. Add the plugin row to `$DSH_HOME/profiles/web/cordis.patch.yml`**:

```yaml
- id: github-reviewer
  name: '@xinlongwu/dsh-github-reviewer'
  config:
    name: personal
    # Either the GitHub App triple (appId/installationId/privateKeyPath)
    # or a personal access token:
    personalAccessToken: 'github_pat_...'
    repositories:
      - 'owner/repo'
    mcp:
      command: 'github-mcp-server'
      args: ['stdio', '--tools=pull_requests,repos,issues']
      # Container variant:
      # command: 'docker'
      # args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_HOST',
      #        'ghcr.io/github/github-mcp-server', 'stdio', '--tools=pull_requests,repos,issues']
```

**4. Create a PAT** (PAT mode): GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens, scoped to the target repository only, with permissions: Contents: Read, Pull requests: Read & Write, Issues: Read & Write, Checks: Read (Metadata is implicit).

**5. Restart the instance and verify**: the startup log should show `starting github account=personal repos=1`; open PRs receive a COMMENT review within one poll interval, and commenting `/bot <question>` on a PR talks to the reviewer.

## Configuration

Mount the plugin in the harness `cordis.yml`, **one plugin instance per account** (flat config, multi-instance pattern):

```yaml
- id: github-reviewer-org
  name: '@xinlongwu/dsh-github-reviewer'
  config:
    name: org                             # account label: logs + cursor record key
    appId: '123456'
    installationId: '987654'
    privateKeyPath: '/etc/dsh/github-app.pem'
    # Or use a personal access token instead of the three App fields
    # (the two auth modes are mutually exclusive):
    # personalAccessToken: 'github_pat_...'
    baseUrl: 'https://api.github.com'      # optional
    webUrl: 'https://github.com'           # optional
    pollIntervalMs: 120000                 # optional, default 2m
    repositories:
      - 'owner/repo'
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
```

Multiple accounts = another plugin instance with the same `name`, each running its own poll loop.

### Config reference

| Field | Default | Description |
|---|---|---|
| `name` | `default` | Account label used in logs and the cursor record key |
| `appId` | — | GitHub App ID (required in App mode) |
| `installationId` | — | GitHub App installation ID used to mint installation tokens (required in App mode) |
| `privateKeyPath` | — | Local PEM private key path for signing GitHub App JWTs (required in App mode) |
| `personalAccessToken` | — | Personal access token (classic `ghp_` or fine-grained `github_pat_`); mutually exclusive with the three App fields |
| `baseUrl` | `https://api.github.com` | GitHub REST API base URL |
| `webUrl` | `https://github.com` | GitHub web URL and MCP `GITHUB_HOST` value |
| `pollIntervalMs` | `120000` | Interval between PR polling passes |
| `repositories` | — | Repository allowlist in `owner/repo` form; at least one is required |
| `review.maxToolCalls` | `30` | Tool-call budget for one review turn; the guard rejects further calls |
| `review.toolTimeoutMs` | `30000` | Per-tool-call timeout |
| `review.toolResultLimit` | `60000` | Maximum tool-result characters returned to the model per call |
| `review.timeoutMs` | `900000` | Overall deadline for one turn; the agent is cancelled past it |
| `review.defaultInstructions` | — | Fallback instructions used only when `.github/review_instructions.md` is missing from the base repository |
| `review.commandAuthorAssociations` | `['OWNER','MEMBER','COLLABORATOR']` | GitHub `author_association` values allowed to trigger `/review` and `/bot` commands (case-insensitive); `['*']` allows everyone, an empty array allows no one |
| `mcp.command` | — | Command used to start the per-turn GitHub MCP server (required) |
| `mcp.args` | — | Arguments for the server; include explicit `--tools=...` (strongly recommended; the guard filters out tools not listed) |
| `mcp.env` | `{}` | Extra MCP server environment variables; GitHub tokens are injected automatically |
| `mcp.cwd` | — | Optional working directory for the server |


Misconfiguration fails the plugin at load: missing credentials, invalid repository names, unreadable private keys, and missing MCP command/args all throw during activation instead of silently skipping reviews.

## How it works

### Polling and cursor state

Each account runs its own poll loop (an immediate pass, then every `pollIntervalMs`). Ticks never overlap. For each PR the poller decides:

- New PR or changed `head.sha` → run a review.
- Reviewed or `missing_instructions` PR with an unchanged SHA → poll comments for `/review` and `/bot` commands.

Cursor state lives in the harness storage domain (`dsh_github_reviewer` domain, `accounts` table, one record per account), persisted by whichever backend the deployment routes to the domain — JSON files with `dsh-storage-json`, or a real SQLite database with `dsh-storage-sqlite`.

### Per-PR agent and session

On first contact with a PR, the runner asks the agent registry for an Agent whose session id is derived from the account and PR (`github:<account>:<owner>:<repo>:pr:<number>`):

- If the PR session already exists in `sessionPersistence`, it is **resumed** with the same setup world (world = the system-prompt sections and scoped tools registered on an agent's scope context at creation).
- Otherwise a fresh agent and session are created; the session id is stable, so a later restart resumes the same PR conversation.

The agent setup registers the review world on the unpublished agent context: a `complete` system-prompt section (the review or chat prompt, selected per turn), the four guarded GitHub tools as scoped tool definitions, and a tool restriction that hides **every global tool** from this agent — the model sees only the closed review tool set, mirroring LingoBridge's guarded-only handler. The session log is the durable per-PR history — later turns replay it through the loop, and checkpoints/compaction apply exactly as for interactive sessions.

### Review flow

1. Read trusted instructions from the base repository (base branch, then base SHA) or the configured default.
2. Spawn the per-turn GitHub MCP server with a fresh installation token and `GITHUB_HOST` injected.
3. Arm the turn slot (turn slot = the per-turn mutable context: current PR, flow, instructions, live MCP host, guard state) and wake the PR agent with the review user prompt via `agent.followup`.
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

- Review session logs (including diffs and file contents) are written to disk through `sessionPersistence`; if the repository contains secrets, mind where these logs are stored.
- The `complete` system-prompt section only replaces the prompt sections — it does not suppress the harness runtime contexts, so if the deployment mounts a workspace-context-style plugin, untrusted text can still reach the model input.

### Personal access token (PAT) mode

Setting `personalAccessToken` (classic `ghp_` or fine-grained `github_pat_`) replaces the three App fields; the two auth modes are mutually exclusive. Mind the semantic differences from App mode:

- Reviews and comments are posted **as you**, with no `[bot]` marker.
- Prefer a fine-grained PAT with minimal permissions: Contents: Read, Pull requests: Read & Write, Issues: Read & Write, Checks: Read (Metadata is implicit).
- Replies posted with a PAT have `user.type` `User`, not `Bot`, so they are not filtered as bot comments: a reply starting with `/bot` would be treated as a command again (this plugin's own replies never do). Take care when sharing a repository with other bots that act as regular users.
- Your own comments have the `OWNER` author association, which the default command allowlist includes.

## Development

```sh
npm install
npm run typecheck
npm test
npm run coverage
npm run build
```

## Known Limitations and Deferred Work

- The cursor lives in the harness storage domain; with a single-host JSON-file backend, two hosts running the same account would still poll twice. PR sessions are durable through the harness, but review *triggers* are not (LingoBridge keeps both in its per-account store).
- The plugin requires a full agent-loop deployment (`agents` + `sessions`); it no longer activates in bare compositions without them. Without a `sessionPersistence` provider, PR sessions are memory-only across restarts.
- PR sessions share the session store with interactive sessions; they are visible and replayable there, but nothing labels them as reviewer sessions beyond the session id.
- GitHub API rate limits are surfaced as errors and the poll continues on the next tick; there is no backoff beyond the poll interval.
- Comment polling uses the cursor timestamps as the `since` bound, so comments deleted before the next poll are not seen.
