# How it works

English | [中文](architecture.md)

## Polling and cursor state

Each account runs its own poll loop (an immediate pass, then every `pollIntervalMs`). Ticks never overlap. For each PR the poller decides:

- New PR or changed `head.sha` → run a review.
- Reviewed or `missing_instructions` PR with an unchanged SHA → poll comments for `/review` and `/bot` commands.
- A PR in the `reviewing` state → the last review was interrupted (process crash/kill): the next tick re-runs the review, resuming the PR's persisted session to finish the remaining work; failed attempts back off instead of spinning.

Cursor state lives in the harness storage domain (`dsh_github_reviewer` domain, `accounts` table, one record per account), persisted by whichever backend the deployment routes to the domain — JSON files with `dsh-storage-json`, or a real SQLite database with `dsh-storage-sqlite`. Each PR's `status` is one of `reviewed` (COMMENT review submitted), `missing_instructions` (no trusted instructions; retried only on head change), or `reviewing` (review in flight/interrupted; resumed on the next poll).

## Per-PR agent and session

On first contact with a PR, the runner asks the agent registry for an Agent whose session id is derived from the account and PR (`github:<account>:<owner>:<repo>:pr:<number>`):

- If the PR session already exists in `sessionPersistence`, it is **resumed** with the same setup world (world = the system-prompt sections and scoped tools registered on an agent's scope context at creation).
- Otherwise a fresh agent and session are created; the session id is stable, so a later restart resumes the same PR conversation.

When the `session-title` service is mounted (bundled with the web profile), each session title is pinned to `Review <owner>/<repo> PR <number>` (e.g. `Review Xinlong-Wu/dsh-github-reviewer PR 18`); automatic title generation never overrides it.

The agent setup registers the review world on the unpublished agent context: a `complete` system-prompt section (the review or chat prompt, selected per turn), the four guarded GitHub tools as scoped tool definitions, and a tool restriction that hides **every global tool** from this agent — the model sees only the closed review tool set, mirroring LingoBridge's guarded-only handler. The session log is the durable per-PR history — later turns replay it through the loop, and checkpoints/compaction apply exactly as for interactive sessions.

## Review flow

1. Read trusted instructions from the base repository (base branch, then base SHA) or the configured default.
2. Spawn the per-turn GitHub MCP server with a fresh installation token and `GITHUB_HOST` injected. Tool schemas are discovered once per process and cached (they depend on neither the PR nor the token), so a burst of new PRs does not reconnect repeatedly.
3. Arm the turn slot (turn slot = the per-turn mutable context: current PR, flow, instructions, live MCP host, guard state) and wake the PR agent with the review user prompt via `agent.followup`. The user prompt carries structured PR metadata (repository/number/title/URL/base/head) plus the diff size (`size: N files (+X/-Y)`, from the list payload — the model picks `get_diff` vs paginated `get_files` accordingly); the body is truncated at 8k characters and marked `[truncated, use pull_request_read method=get]` — the model reads the full body itself when needed.
4. Await `agent.whenIdle()`: the loop drives model steps and tool calls; the guarded tools enforce the review rules on every call.
5. Flush the session to persistence and mark the PR `reviewed` only when the guarded `submit_pending` call with `event=COMMENT` succeeded.

## Tool guards

The four tools (`mcp_github_pull_request_read`, `mcp_github_get_file_contents`, `mcp_github_pull_request_review_write`, `mcp_github_add_comment_to_pending_review`) are registered only on the PR agent's scope, bound to that PR, and the agent scope hides every global tool — other agents never see them, and the review agent never sees global tools:

- `pull_request_read`: only `get`, `get_diff`, `get_files`, `get_status`, `get_check_runs`; must target the current PR.
- `get_file_contents`: base/head repositories only; `sha` must be the current base or head SHA; `ref` must be the base/head branch, `refs/heads/<branch>`, `refs/pull/<number>/head` on the base repo, or one of those SHAs; `sha` and `ref` must not both be set. Omitting both defaults to the head SHA.
- `pull_request_review_write`: `create` must not carry `event`/`body`, `commitID` is validated against (or injected as) the head SHA, and extra fields are dropped; `submit_pending` only with `event=COMMENT`.
- `add_comment_to_pending_review`: relative paths only; `FILE` or `LINE` comments with `line`/`side` and paired `startLine`/`startSide` validation.

Approvals, request-changes reviews, thread resolution, PR updates, merges, and repository writes are rejected before reaching the MCP server. The tool-call budget (`maxToolCalls`), per-call timeout, result truncation, and the turn deadline are enforced by the guard and the runner on top of the loop.

## Trust model

The review system prompt is registered as the agent's complete system prompt and carries trusted instructions only from the base-repo file or the configured default. PR metadata, title/body, diffs, changed files, and tool output are untrusted context; the title/body is sanitized before prompt placement, and the prompt instructs the model not to follow instructions found in untrusted context.

- Review session logs (including diffs and file contents) are written to disk through `sessionPersistence`; if the repository contains secrets, mind where these logs are stored.
- The `complete` system-prompt section only replaces the prompt sections — it does not suppress the harness runtime contexts, so if the deployment mounts a workspace-context-style plugin, untrusted text can still reach the model input.

## Personal access token (PAT) mode

Setting `personalAccessToken` (classic `ghp_` or fine-grained `github_pat_`) replaces the three App fields; the two auth modes are mutually exclusive. Mind the semantic differences from App mode:

- Reviews and comments are posted **as you**, with no `[bot]` marker.
- Prefer a fine-grained PAT with minimal permissions: Contents: Read, Pull requests: Read & Write, Issues: Read & Write, Checks: Read (Metadata is implicit).
- Replies posted with a PAT have `user.type` `User`, not `Bot`, so they are not filtered as bot comments: a reply starting with `/bot` would be treated as a command again (this plugin's own replies never do). Take care when sharing a repository with other bots that act as regular users.
- Your own comments have the `OWNER` author association, which the default command allowlist includes.
