# dsh-github-reviewer

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/@xinlongwu/dsh-github-reviewer)](https://www.npmjs.com/package/@xinlongwu/dsh-github-reviewer)
[![CI](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Xinlong-Wu/dsh-github-reviewer/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@xinlongwu/dsh-github-reviewer)](https://github.com/Xinlong-Wu/dsh-github-reviewer/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@xinlongwu/dsh-github-reviewer)](https://nodejs.org)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that polls configured GitHub repositories for open pull requests and posts automated `COMMENT` reviews. It is a TypeScript port of the GitHub reviewer built into [LingoBridge](https://github.com/Xinlong-Wu/LingoBridge), and it drives every review and `/bot` chat through the **harness agent loop**: one live Agent per PR, one session log per PR, durable through the harness session-persistence seam.

## Features

- Polls configured repositories for open pull requests; draft PRs are skipped.
- Authenticates as a GitHub App (RS256 app JWT → short-lived installation tokens, cached until near expiry) or with a personal access token (PAT mode).
- Reviews a PR when it first appears or when its `head.sha` changes; unchanged PRs are tracked in a per-account cursor record in the storage domain and not reviewed again.
- Reads trusted review instructions only from `.github/review_instructions.md` in the base repository (base branch, then base SHA). If the file is missing and `defaultInstructions` is configured, that text is used; otherwise the PR is marked `missing_instructions` and retried only after the head SHA changes.
- **One harness Agent and session per PR.** Reviews and `/bot` chats on the same PR run in the same session, so the loop replays the PR's full conversation history — the model remembers earlier findings and discussions. Sessions persist across restarts through `sessionPersistence` when a provider is mounted, and the reviewer resumes the existing session instead of starting a fresh one.
- Runs the review through the real agent loop: the review system prompt is registered as a `complete` system-prompt section on the PR agent, and the guarded GitHub tools are registered as scoped harness tools, so the loop's logging, checkpoints, and compaction all apply.
- Spawns a fresh per-turn GitHub MCP server (`github-mcp-server`) over stdio, injecting the installation token as `GITHUB_PERSONAL_ACCESS_TOKEN` and the configured web URL as `GITHUB_HOST`; tool schemas are discovered once per process and cached.
- Guards every tool call: calls must target the current PR, reads are limited to allowed methods and refs, and writes are limited to the `create` → inline comments → `submit_pending(event=COMMENT)` pending-review workflow.
- Handles comment commands on already-processed PRs: `/review` triggers a re-review, `/bot <message>` continues the PR conversation and posts the reply to the issue thread or the review thread it answered.
- Interrupted reviews resume: the `reviewing` cursor state re-triggers the review after a restart and continues the remaining work from the persisted session.
- Sanitizes untrusted PR title/body text before prompt placement (HTML comments/hidden attributes, invisible/control characters, markdown image alt text, markdown link titles, GitHub token-like strings).

## Quick start

```sh
npm install @xinlongwu/dsh-github-reviewer
```

Mount the plugin with `- insert:` in the profile's `cordis.patch.yml` (full steps in [Deployment and Mounting](docs/deploy.en.md)); after restarting the harness, open PRs receive a `COMMENT` review within one poll interval, and commenting `/bot <question>` on a PR talks to the reviewer.

## Documentation

| Topic | English | 中文 |
|---|---|---|
| Deployment & mounting: requirements, profile patch syntax, MCP server, verification | [docs/deploy.en.md](docs/deploy.en.md) | [docs/deploy.md](docs/deploy.md) |
| Configuration reference: fields, env injection, `!!js` expressions | [docs/config.en.md](docs/config.en.md) | [docs/config.md](docs/config.md) |
| How it works: polling/cursor, review flow, tool guards, trust model | [docs/architecture.en.md](docs/architecture.en.md) | [docs/architecture.md](docs/architecture.md) |
| Development and known limitations | [docs/development.en.md](docs/development.en.md) | [docs/development.md](docs/development.md) |

The fully annotated minimal composition example lives in [cordis.yml.example](./cordis.yml.example).

## License

[Apache-2.0](LICENSE)
