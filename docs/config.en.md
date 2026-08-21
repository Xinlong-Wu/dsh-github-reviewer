# Configuration

English | [中文](config.md)

After installing the bundle, complete the default `github-reviewer` row's runtime config by id in the profile's `cordis.patch.yml` before the next start (see [Deployment and Mounting](./deploy.en.md)). The row is enabled by default and `uiSettings` defaults to `true`. Use **one plugin instance per account** (flat config, multi-instance pattern); add extra accounts with `- insert:`. The default instance's full config fields are:

```yaml
- id: github-reviewer
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

Multiple accounts = another plugin instance with the same `name`, each running its own poll loop. The default instance exposes the Web card without an explicit field because `uiSettings` defaults to `true`; extra accounts remain composition-managed and must explicitly set `uiSettings: false`.

The **GitHub Reviewer** Web card starts collapsed and overrides only `repositories`, `pollIntervalMs`, workspace fields, and `review.*`. Repositories use searchable owner (organization or user)/repository Combobox rows with icon-only add/remove actions. On first focus, the Host uses the configured credential and `baseUrl` to page accessible repositories: PAT mode calls `/user/repos`, while GitHub App mode calls `/installation/repositories`. Owner suggestions are derived from those repositories, and repository suggestions are filtered by the current owner. Tokens, private keys, and raw API responses never cross into the browser. Both fields always accept free text; a catalog failure or value outside the catalog produces only a non-blocking notice and never prevents saving. Model candidates use provider/model select rows sourced from the Host `llm.models` catalog. Candidates are prioritized top to bottom and can be reordered by dragging the handle or using Arrow Up/Down while it is focused. Authentication, GitHub URLs, and MCP process settings remain in `cordis.patch.yml`. Saving writes the settings user-override layer rather than rewriting the profile, and clearing a field restores inheritance from the profile. A successful save means “persisted and asynchronous reviewer-runtime restart requested,” not that the whole DSH process restarted.

`settings`, `workspaceRegistry`, and the Client UI are optional injected companions. Missing or later-unmounted companions do not stop the Host reviewer; detaching settings falls back to composition config and restarts only the internal reviewer runtime.

## Config reference

| Field | Default | Description |
|---|---|---|
| `name` | `default` | Account label used in logs and the cursor record key |
| `uiSettings` | `true` | Register the fixed `github-reviewer` Web settings namespace; only one instance may enable it and extra accounts must explicitly set it to `false` |
| `appId` | — | GitHub App ID (required in App mode) |
| `installationId` | — | GitHub App installation ID used to mint installation tokens (required in App mode) |
| `privateKeyPath` | — | Local PEM private key path for signing GitHub App JWTs (required in App mode) |
| `personalAccessToken` | — | Personal access token (classic `ghp_` or fine-grained `github_pat_`); mutually exclusive with the three App fields |
| `baseUrl` | `https://api.github.com` | GitHub REST API base URL |
| `webUrl` | `https://github.com` | GitHub web URL and MCP `GITHUB_HOST` value |
| `pollIntervalMs` | `120000` | Interval between PR polling passes |
| `repositories` | `[]` | Repository allowlist in `owner/repo` form; an empty list keeps the reviewer running but polls no repositories |
| `workspaceDir` | `$DSH_HOME/github-reviewer/<name>` | Review/chat session directory; registered as a harness workspace when `@deepseek-ai/dsh-workspace` is mounted (the web profile includes it and it publishes `workspaceRegistry`), so PR sessions group there instead of the ungrouped bucket |
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
- id: github-reviewer
  # Keep Loader fields and plugin config at their respective levels; for example:
  disabled: !!js "process.platform === 'win32'"
  config:
    # read from the environment instead of a literal token:
    personalAccessToken: !!js process.env.GITHUB_PAT
    # quote fallback expressions containing operators:
    # personalAccessToken: !!js "process.env.GITHUB_PAT ?? ''"
    # keep numeric conversion inside the expression:
    # pollIntervalMs: !!js "process.env.DSH_GHR_POLL_MS ? Number(process.env.DSH_GHR_POLL_MS) : 120000"
    # join segments onto $DSH_HOME (default ~/.dsh):
    # privateKeyPath: !!js "dshHomePath('secrets', 'github-app.pem')"
```

- **Scope**: the expression evaluates inside `with(ctx)` over the loader context — `process` is available (`process.env.X`, `process.cwd()`, `process.platform`, …) plus `dshHomePath(...segments)` (joins segments onto `$DSH_HOME`); full JS syntax (`??`, ternaries, template strings) works.
- **Quoting**: plain scalars need no quotes (`!!js process.env.X`); **expressions containing spaces/operators/quotes must be quoted as a whole** (`!!js "a ?? b"`).
- **Timing & trust**: evaluation happens once at boot while the config tree loads (synchronous, not hot-reloaded); expressions run with `eval` semantics, so keep them trusted.

Misconfiguration fails the plugin at load: missing credentials, invalid repository names, unreadable private keys, and missing MCP command/args all throw during activation instead of silently skipping reviews.
