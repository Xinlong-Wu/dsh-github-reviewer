# Configuration

English | [中文](config.md)

After installing the bundle, override and enable its default `github-reviewer` row in the profile's `cordis.patch.yml` (see [Deployment and Mounting](./deploy.en.md)). Use **one plugin instance per account** (flat config, multi-instance pattern); add extra accounts with `- insert:`. The default instance's full config fields are:

```yaml
- id: github-reviewer
  disabled: false
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

## Config reference

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
| `workspaceDir` | `$DSH_HOME/github-reviewer/<name>` | Review/chat session directory; registered as a harness workspace (when the `workspace` service is mounted, as in the web profile) so PR sessions group there instead of the ungrouped bucket |
| `workspaceTitle` | `GithubReviewer` | Display title of that workspace |
| `review.maxToolCalls` | `30` | Tool-call budget for one review turn; the guard rejects further calls |
| `review.toolTimeoutMs` | `30000` | Per-tool-call timeout |
| `review.toolResultLimit` | `60000` | Maximum tool-result characters returned to the model per call |
| `review.timeoutMs` | `900000` | Overall deadline for one turn; the agent is cancelled past it |
| `review.defaultInstructions` | — | Fallback instructions used only when `.github/review_instructions.md` is missing from the base repository |
| `review.commandAuthorAssociations` | `['OWNER','MEMBER','COLLABORATOR']` | GitHub `author_association` values allowed to trigger `/review` and `/bot` commands (case-insensitive); `['*']` allows everyone, an empty array allows no one |
| `review.models` | `[]` (use the deployment default) | Ordered review-model candidates `[{provider, model}]`. **Resolved at the first session creation**, not at plugin mount: the first candidate whose provider is registered and whose model appears in that provider's catalog wins; when none is available that review is aborted and the failure is recorded in the cursor (retried after backoff). "Available" is a catalog check (`llm.listModels`), not a live connection probe. Empty uses the deployment's `agentDefaultModel` |
| `mcp.command` | — | Command used to start the per-turn GitHub MCP server (required) |
| `mcp.args` | — | Arguments for the server; include explicit `--tools=...` (strongly recommended; the guard filters out tools not listed) |
| `mcp.env` | `{}` | Extra MCP server environment variables; GitHub tokens are injected automatically |
| `mcp.cwd` | — | Optional working directory for the server |

## Automatic MCP server environment injection

The plugin injects two environment variables into **every per-turn** MCP server it spawns — **there is no need (and no reason) to pass them yourself** in `mcp.args` or `mcp.env`:

| Variable | Value | Notes |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | The effective token for this turn: your `personalAccessToken` in PAT mode; a freshly minted installation token per turn in App mode | Written after the `mcp.env` merge, so it overrides same-named entries |
| `GITHUB_HOST` | `webUrl` (default `https://github.com`) | Same |

- **Binary servers** receive both variables directly — no configuration needed.
- **Container (docker)**: use `-e GITHUB_PERSONAL_ACCESS_TOKEN` / `-e GITHUB_HOST` (**name only**) so docker inherits them from the process environment — do not hardcode `-e NAME=value`: the token would land in the docker argv (visible in `ps` / `docker inspect`), and App-mode installation tokens are minted at runtime, so they do not exist at config load.
- To change the `GITHUB_HOST` default, set `webUrl` instead of passing it in the args.

## JS expressions in the config file (`!!js`)

Config values in patch files (`cordis.patch.yml`, `--patch` overlays, bundles) support the YAML `!!js` tag, evaluated synchronously at boot — usable in any field, including `disabled`:

```yaml
- insert:
    - id: github-reviewer
      name: 'dsh-github-reviewer'
      config:
        # read from the environment instead of a literal token:
        personalAccessToken: !!js process.env.GITHUB_PAT
        # with a fallback default:
        # personalAccessToken: !!js process.env.GITHUB_PAT ?? ''
        # quote expressions containing spaces/operators/quotes:
        # pollIntervalMs: !!js "process.env.DSH_GHR_POLL_MS ? Number(process.env.DSH_GHR_POLL_MS) : 120000"
        # join segments onto $DSH_HOME (default ~/.dsh):
        # privateKeyPath: !!js dshHomePath('secrets', 'github-app.pem')
        # platform-conditional disable:
        # disabled: !!js process.platform === 'win32'
```

- **Scope**: the expression evaluates inside `with(ctx)` over the loader context — `process` is available (`process.env.X`, `process.cwd()`, `process.platform`, …) plus `dshHomePath(...segments)` (joins segments onto `$DSH_HOME`); full JS syntax (`??`, ternaries, template strings) works.
- **Quoting**: plain scalars need no quotes (`!!js process.env.X`); **expressions containing spaces/operators/quotes must be quoted as a whole** (`!!js "a ?? b"`).
- **Timing & trust**: evaluation happens once at boot while the config tree loads (synchronous, not hot-reloaded); expressions run with `eval` semantics, so keep them trusted.

Misconfiguration fails the plugin at load: missing credentials, invalid repository names, unreadable private keys, and missing MCP command/args all throw during activation instead of silently skipping reviews.
