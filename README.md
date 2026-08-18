# dsh-github-reviewer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that polls configured GitHub repositories for open pull requests and posts automated `COMMENT` reviews. It is a TypeScript port of the GitHub reviewer built into [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge), following the harness plugin conventions (Cordis function plugin, named exports, config from `cordis.yml`).

## Features

- Polls configured repositories for open pull requests; draft PRs are skipped.
- Authenticates as a GitHub App: signs RS256 app JWTs and exchanges them for short-lived installation access tokens (cached until near expiry).
- Reviews a PR when it first appears or when its `head.sha` changes; unchanged PRs are tracked in a per-account cursor file and not reviewed again.
- Reads trusted review instructions only from `.github/review_instructions.md` in the base repository (base branch, then base SHA). If the file is missing and `defaultInstructions` is configured, that text is used; otherwise the PR is marked `missing_instructions` and retried only after the head SHA changes.
- Spawns a fresh per-review GitHub MCP server (`github-mcp-server`) over stdio for every review, injecting the installation token as `GITHUB_PERSONAL_ACCESS_TOKEN` and the configured web URL as `GITHUB_HOST`.
- Wraps the MCP tools with PR-review guards: every call must target the current PR, reads are limited to allowed methods and refs, and writes are limited to the `create` → inline comments → `submit_pending(event=COMMENT)` pending-review workflow.
- Drives the review conversation through the harness `llm` service with a dedicated review system prompt and trust boundary; tool results are bounded, each tool call has a timeout, and the whole conversation has an overall deadline and tool-call budget.
- Handles comment commands on already-processed PRs: `/review` triggers a re-review, `/bot <message>` continues the PR conversation and posts the reply to the issue thread or the review thread it answered.
- Sanitizes untrusted PR title/body text before prompt placement (HTML comments/hidden attributes, invisible/control characters, markdown image alt text, markdown link titles, GitHub token-like strings).

## Install

```sh
npm install @lingobridge/dsh-github-reviewer
```

Peer dependency: `@deepseek-ai/cordis` (the harness Cordis runtime). The plugin injects the harness `llm` service, so the deployment must mount an LLM adapter (e.g. the DeepSeek provider plugin).

## Configuration

Mount the plugin in the harness `cordis.yml`:

```yaml
plugins:
  github-reviewer:
    $if: 'has .env.GITHUB_REVIEWER_ENABLED'   # or any conditional you prefer
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

Multiple accounts run independent poll loops. See [cordis.yml.example](./cordis.yml.example) for the full example.

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
| `accounts.<name>.review.maxToolCalls` | `30` | Tool-call limit for one review conversation |
| `accounts.<name>.review.toolTimeoutMs` | `30000` | Per-tool-call timeout |
| `accounts.<name>.review.toolResultLimit` | `60000` | Maximum tool-result characters returned to the model per call |
| `accounts.<name>.review.timeoutMs` | `900000` | Overall deadline for one review conversation |
| `accounts.<name>.review.defaultInstructions` | — | Fallback instructions used only when `.github/review_instructions.md` is missing from the base repository |
| `accounts.<name>.mcp.command` | — | Command used to start the per-review GitHub MCP server (required) |
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

### Review flow

1. Read trusted instructions from the base repository (base branch, then base SHA) or the configured default.
2. Mint a fresh installation token and spawn the per-review GitHub MCP server with `GITHUB_PERSONAL_ACCESS_TOKEN` and `GITHUB_HOST` injected.
3. Guard the discovered tools: only `pull_request_read`, `get_file_contents`, `pull_request_review_write`, and `add_comment_to_pending_review` are exposed, renamed as `mcp_github_<tool>`.
4. Run one review conversation through the harness `llm` service with the dedicated review system prompt.
5. Mark the PR `reviewed` only when the guarded `submit_pending` call with `event=COMMENT` succeeds.

### Tool guards

- `pull_request_read`: only `get`, `get_diff`, `get_files`, `get_status`, `get_check_runs`; must target the current PR.
- `get_file_contents`: base/head repositories only; `sha` must be the current base or head SHA; `ref` must be the base/head branch, `refs/heads/<branch>`, `refs/pull/<number>/head` on the base repo, or one of those SHAs; `sha` and `ref` must not both be set. Omitting both defaults to the head SHA.
- `pull_request_review_write`: `create` must not carry `event`/`body`, `commitID` is validated against (or injected as) the head SHA, and extra fields are dropped; `submit_pending` only with `event=COMMENT`.
- `add_comment_to_pending_review`: relative paths only; `FILE` or `LINE` comments with `line`/`side` and paired `startLine`/`startSide` validation.

Approvals, request-changes reviews, thread resolution, PR updates, merges, and repository writes are rejected before reaching the MCP server.

### Trust model

The review system prompt carries trusted instructions only from the base-repo file or the configured default. PR metadata, title/body, diffs, changed files, and tool output are untrusted context; the title/body is sanitized before prompt placement, and the prompt instructs the model not to follow instructions found in untrusted context.

### Model conversation

Review conversations are one-shot calls through the harness `llm` service (`provider` + `model` per account); they do not create session-log records. Tool results are truncated to `toolResultLimit` characters, each tool call is bounded by `toolTimeoutMs`, the conversation by `timeoutMs` and `maxToolCalls`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Known Limitations and Deferred Work

- The cursor file is local to the process host; running two hosts against the same account would poll twice (LingoBridge keeps cursors in its per-account store).
- Review conversations bypass the harness session log, so they are not replayable or inspectable in session UIs.
- GitHub API rate limits are surfaced as errors and the poll continues on the next tick; there is no backoff beyond the poll interval.
- Comment polling uses the cursor timestamps as the `since` bound, so comments deleted before the next poll are not seen.
