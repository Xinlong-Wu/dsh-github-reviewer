# Deployment and Mounting

English | [中文](deploy.md)

This page explains how to deploy `@xinlongwu/dsh-github-reviewer` into a DeepSeek Harness instance. See [Configuration](./config.en.md) for the config reference and [Architecture](./architecture.en.md) for how it works.

## Deployment requirements

The plugin injects the harness `agents`, `sessions`, and `agentDefaultModel` services, so the deployment must mount the agent-loop family. A minimal working composition needs at least these rows beside `github-reviewer` (see [cordis.yml.example](../cordis.yml.example) for the full annotated example):

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

- **The default model is not plugin-configured**: with `review.models` left empty, every review agent uses the deployment's default model selection (`agentDefaultModel`), provided by `@deepseek-ai/dsh-agent-default-model` on its own (config requires `{ provider, model }`), not by the agent-spine family. Configure `review.models` for a candidate list (see [Configuration](./config.en.md)).
- **Unsatisfied dependencies silently deactivate the plugin**: when a cordis dependency is missing, the fiber stays PENDING forever and the plugin never activates — so the `agent-default-model` row and the storage rows (`storage` hub, `storage-json` backend, `storage-domain`) added above are required.
- **The cursor needs the storage domain**: the `dsh_github_reviewer` domain is provided by `@deepseek-ai/dsh-storage-domain`, which needs a backend (`@deepseek-ai/dsh-storage-json` or `@deepseek-ai/dsh-storage-sqlite`) routed in the storage-domain config (e.g. `backend: json` or `backend: sqlite`). The plugin fails loudly at load without it.
- **Without `sessionPersistence`**: the reviewer still works, but PR sessions are memory-only — after a restart the loop starts each PR from a fresh session.
- **With `sessionPersistence`**: every turn is checkpointed, and the reviewer resumes the persisted PR session on restart (it never creates a second session for the same PR).
- PR sessions live in the same session store as interactive sessions, so reviews are visible and replayable in the harness session UI.

## Install and peer dependencies

```sh
npm install @xinlongwu/dsh-github-reviewer
```

Peer dependencies: every `@deepseek-ai/*` package the plugin touches — `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-agent-default-model`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-persistence`, `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`, and `@deepseek-ai/schemastery`. They are declared as peers on purpose: the harness installation already provides them, and installing a second copy into the profile breaks the whole process — the tool scheduler looks up a module-private symbol on the shared `tools` service, and a duplicate `@deepseek-ai/dsh-tools` instance makes that lookup return `undefined`, crashing every session's first tool call with `Cannot read properties of undefined (reading 'prepare')`. Only `@modelcontextprotocol/sdk` and `zod` are installed as real dependencies.

## Enabling on a running DSH instance

Assume the instance profile lives at `$DSH_HOME/profiles/web` (`DSH_HOME` defaults to `~/.dsh`).

The plugin is loaded through the harness **profile composition**: the composed tree is the official bundle layer (`dsh-base`, `dsh-web-app`, declared in the profile's `dsh.profile.bundles`), then your `cordis.patch.yml`, then any `--patch` overlays from the launcher. A standard web profile already provides every service the plugin needs — **nothing extra to mount**:

| Service the plugin needs | Provided by | Where |
|---|---|---|
| `agents` / `sessions` | `@deepseek-ai/dsh-agent` / `dsh-session` | dsh-base bundle |
| `agentDefaultModel` | `@deepseek-ai/dsh-agent-default-model` (model chosen in `settings.yaml`) | dsh-base bundle |
| `sessionPersistence` | `@deepseek-ai/dsh-session-persistence-jsonl` | dsh-base bundle |
| `storageDomain` (cursor) | `@deepseek-ai/dsh-storage-domain` + `dsh-storage-json` backend | dsh-web-app bundle |

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
# Official way: the dsh CLI forwards to pnpm inside the profile directory
dsh plugin --profile web add @xinlongwu/dsh-github-reviewer

# Equivalent manual way:
cd "$DSH_HOME/profiles/web"
npx pnpm add @xinlongwu/dsh-github-reviewer
ls node_modules/@xinlongwu/dsh-github-reviewer/lib/index.js   # confirm the install
```

The profile's `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so pnpm installs only the plugin plus its real dependencies (`@modelcontextprotocol/sdk`, `zod`); every `@deepseek-ai/*` peer resolves from the harness installation, keeping a single copy of each package in the process (see the peer-dependency note above).

**3. Declare the plugin in `$DSH_HOME/profiles/web/cordis.patch.yml`**.

Mind the patch syntax: a **plain row at the top level is an id-targeted override** of a row that already exists in the composed tree (if the id is missing you get `patch: entry "<id>" not found`); **a new plugin row must be wrapped in an `- insert:` list**:

```yaml
- insert:
    - id: github-reviewer
      name: '@xinlongwu/dsh-github-reviewer'
      config:
        name: personal
        # Either the GitHub App triple (appId/installationId/privateKeyPath)
        # or a personal access token. Avoid a literal token in this file —
        # read it from the environment with a !!js expression instead:
        # personalAccessToken: !!js process.env.GITHUB_PAT
        personalAccessToken: 'github_pat_...'
        repositories:
          - 'owner/repo'
        mcp:
          command: 'github-mcp-server'
          args: ['stdio', '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review']
          # Container variant (-e takes the variable name only; the plugin
          # injects the value into the process env and docker forwards it):
          # command: 'docker'
          # args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_HOST',
          #        'ghcr.io/github/github-mcp-server', 'stdio',
          #        '--tools=pull_request_read,get_file_contents,pull_request_review_write,add_comment_to_pending_review']
```

Multiple accounts = another instance with the same `name` inside the same `- insert:` list (different `id`), each running its own poll loop.

**4. Create a PAT** (PAT mode): GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens, scoped to the target repository only, with permissions: Contents: Read, Pull requests: Read & Write, Issues: Read & Write, Checks: Read (Metadata is implicit).

**5. Restart the instance and verify**:

```sh
dsh web
dsh --profile web --dump-config   # print the composed plugin tree; confirm the github-reviewer row
```

The startup log should show `starting github account=personal repos=1`; open PRs receive a COMMENT review within one poll interval, and commenting `/bot <question>` on a PR talks to the reviewer. If `--dump-config` reports `patch: entry "..." not found`, the row was treated as an override of an existing id — check that it is wrapped in `- insert:`.

Once enabled, review/chat sessions are filed under an auto-registered `GithubReviewer` workspace. The plugin mounts a companion that, through the inject system, activates **at the exact moment the workspace service becomes available**: it creates the directory and registers the workspace, with no polling or retry. In compositions without the service the companion stays idle — no directory or registration work, and the reviewer itself is unaffected. Adjust with `workspaceDir` / `workspaceTitle`. Pre-existing sessions stay in their old workspace; only new sessions use the new directory.
