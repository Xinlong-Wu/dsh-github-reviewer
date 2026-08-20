/**
 * Plugin configuration: one review account per plugin instance, authenticated
 * either as a GitHub App installation or with a personal access token.
 * Mount the plugin once per account in the harness composition (the
 * multi-instance pattern, like `mcp-client`); the deployment's default model
 * selection drives every review agent, so no model fields live here.
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepository } from './github/model.ts'
import type { ReviewerSettings } from './settings-contract.ts'

export type { ReviewerSettings } from './settings-contract.ts'

/** Defaults shared with LingoBridge. */
export const DEFAULT_BASE_URL = 'https://api.github.com'
export const DEFAULT_WEB_URL = 'https://github.com'
export const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000
export const DEFAULT_MAX_TOOL_CALLS = 30
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000
export const DEFAULT_TOOL_RESULT_LIMIT = 60_000
/** Overall deadline for one review conversation. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60_000
/** Default account label when the instance config omits `name`. */
export const DEFAULT_ACCOUNT_NAME = 'default'
/** Default harness workspace title that review-agent sessions are filed under. */
export const DEFAULT_WORKSPACE_TITLE = 'GithubReviewer'
/**
 * Default `author_association` values allowed to trigger `/review` and `/bot`:
 * maintainers only, so strangers on public repos cannot drive LLM spend.
 */
export const DEFAULT_COMMAND_AUTHOR_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

/** One candidate model for review agents: provider route + exact model id. */
export interface ReviewModel {
  provider: string
  model: string
}

/** Per-account review limits, fully resolved after normalization. */
export interface ReviewConfig {
  maxToolCalls: number
  toolTimeoutMs: number
  toolResultLimit: number
  /** Overall deadline for one review conversation in milliseconds. */
  timeoutMs: number
  defaultInstructions: string
  /**
   * GitHub `author_association` values allowed to trigger `/review` and `/bot`
   * commands. Defaults to maintainers; `['*']` allows anyone.
   */
  commandAuthorAssociations: string[]
  /**
   * Ordered review-model candidates, `{provider, model}` pairs. When non-empty,
   * the plugin picks the first candidate whose provider is mounted and whose
   * model appears in that provider's catalog, and uses it for every review
   * agent instead of the deployment's default model selection. A load error is
   * thrown when none of the candidates is available. Empty means "use the
   * deployment default" (`agentDefaultModel`).
   */
  models: ReviewModel[]
}

/** Per-review GitHub MCP server spawn parameters, fully resolved after normalization. */
export interface McpConfig {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** One review account as loaded from cordis.yml, flat per instance. */
export interface Config {
  /** Account label used in logs and as the cursor record key; defaults to `default`. */
  name?: string
  /** Register the optional Web settings namespace for this instance. Only one instance may enable it. */
  uiSettings?: boolean
  appId: string
  installationId: string
  privateKeyPath: string
  /**
   * Personal access token (classic `ghp_` or fine-grained `github_pat_`).
   * When set, the App credentials must be empty: the two auth modes are
   * mutually exclusive and the token alone selects PAT mode.
   */
  personalAccessToken: string
  baseUrl: string
  webUrl: string
  pollIntervalMs: number
  repositories: string[]
  /**
   * Directory that hosts this account's review-agent sessions. Registered as a
   * harness workspace (titled {@link DEFAULT_WORKSPACE_TITLE}) when the
   * deployment mounts `@deepseek-ai/dsh-workspace` and its `workspaceRegistry`
   * service, so PR sessions group there instead of the ungrouped bucket. Defaults to
   * `$DSH_HOME/github-reviewer/<name>`.
   */
  workspaceDir?: string
  /** Display title of the harness workspace created for this account. */
  workspaceTitle?: string
  /** Optional; defaults are materialized by {@link normalizeAccountConfig}. */
  review?: ReviewConfig
  /** Optional; the command and args are required for review operation. */
  mcp?: McpConfig
}

/** One review account with every default resolved. */
export interface ResolvedAccountConfig {
  name: string
  uiSettings: boolean
  appId: string
  installationId: string
  privateKeyPath: string
  personalAccessToken: string
  baseUrl: string
  webUrl: string
  pollIntervalMs: number
  repositories: string[]
  workspaceDir: string
  workspaceTitle: string
  review: ReviewConfig
  mcp: McpConfig
}

const ReviewModelEntry = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

const Review = z.object({
  maxToolCalls: z.number().min(1).default(DEFAULT_MAX_TOOL_CALLS),
  toolTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  toolResultLimit: z.number().min(1).default(DEFAULT_TOOL_RESULT_LIMIT),
  timeoutMs: z.number().min(1).default(DEFAULT_REVIEW_TIMEOUT_MS),
  defaultInstructions: z.string().default(''),
  commandAuthorAssociations: z.array(z.string()).default([...DEFAULT_COMMAND_AUTHOR_ASSOCIATIONS]),
  models: z.array(ReviewModelEntry).default([]),
})

/** Settings schema intentionally excluding account identity, authentication, URLs, and MCP process configuration. */
export const ReviewerSettingsSchema = z.object({
  pollIntervalMs: z.number().min(1000).default(DEFAULT_POLL_INTERVAL_MS),
  repositories: z.array(z.string()).default([]),
  workspaceDir: z.string().default(''),
  workspaceTitle: z.string().default(DEFAULT_WORKSPACE_TITLE),
  review: Review,
}) as unknown as z<ReviewerSettings>

const Mcp = z.object({
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string().default(''),
})

/** Schemastery schema for one plugin instance (one account). */
export const Config = z.object({
  name: z.string().default(DEFAULT_ACCOUNT_NAME),
  uiSettings: z.boolean().default(false),
  appId: z.string().default(''),
  installationId: z.string().default(''),
  privateKeyPath: z.string().default(''),
  personalAccessToken: z.string().role('secret').default(''),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  webUrl: z.string().default(DEFAULT_WEB_URL),
  pollIntervalMs: z.number().min(1000).default(DEFAULT_POLL_INTERVAL_MS),
  repositories: z.array(z.string()).default([]),
  workspaceDir: z.string().default(''),
  workspaceTitle: z.string().default(DEFAULT_WORKSPACE_TITLE),
  review: Review,
  mcp: Mcp,
}) as unknown as z<Config>

/**
 * Normalize one account config: trim strings, resolve the account name,
 * dedupe repositories, and materialize review/MCP defaults the schema leaves
 * optional.
 * @param account - raw account config.
 * @returns normalized account config with every default resolved.
 */
export function normalizeAccountConfig(account: Config): ResolvedAccountConfig {
  const name = (account.name ?? DEFAULT_ACCOUNT_NAME).trim() || DEFAULT_ACCOUNT_NAME
  const repositories: string[] = []
  const seen = new Set<string>()
  for (const raw of account.repositories) {
    const parsed = parseRepository(raw)
    const value = parsed === undefined ? raw.trim() : `${parsed.owner}/${parsed.name}`
    if (value === '') continue
    // GitHub owner/repo names are case-insensitive; dedupe on the folded key.
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    repositories.push(value)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(account.mcp?.env ?? {})) {
    const trimmed = key.trim()
    if (trimmed !== '') env[trimmed] = value
  }
  const args = (account.mcp?.args ?? []).map(value => value.trim()).filter(value => value !== '')
  return {
    name,
    uiSettings: account.uiSettings ?? false,
    appId: account.appId.trim(),
    installationId: account.installationId.trim(),
    privateKeyPath: account.privateKeyPath.trim(),
    personalAccessToken: (account.personalAccessToken ?? '').trim(),
    baseUrl: account.baseUrl.trim().replace(/\/+$/, ''),
    webUrl: account.webUrl.trim().replace(/\/+$/, ''),
    pollIntervalMs: account.pollIntervalMs,
    repositories,
    workspaceDir: resolveWorkspaceDir(account.workspaceDir?.trim() ?? '', name),
    workspaceTitle: (account.workspaceTitle ?? DEFAULT_WORKSPACE_TITLE).trim() || DEFAULT_WORKSPACE_TITLE,
    review: {
      maxToolCalls: account.review?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      toolTimeoutMs: account.review?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      toolResultLimit: account.review?.toolResultLimit ?? DEFAULT_TOOL_RESULT_LIMIT,
      timeoutMs: account.review?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      defaultInstructions: (account.review?.defaultInstructions ?? '').trim(),
      commandAuthorAssociations: (account.review?.commandAuthorAssociations ?? DEFAULT_COMMAND_AUTHOR_ASSOCIATIONS)
        .map(value => value.trim().toUpperCase())
        .filter(value => value !== ''),
      models: (account.review?.models ?? [])
        .map(model => ({ provider: model.provider.trim(), model: model.model.trim() }))
        .filter(model => model.provider !== '' && model.model !== ''),
    },
    mcp: {
      command: (account.mcp?.command ?? '').trim(),
      args,
      env,
      cwd: (account.mcp?.cwd ?? '').trim(),
    },
  }
}

/** Extract the non-secret settings base from a normalized account configuration. */
export function reviewerSettingsOf(account: ResolvedAccountConfig): ReviewerSettings {
  return {
    pollIntervalMs: account.pollIntervalMs,
    repositories: [...account.repositories],
    workspaceDir: account.workspaceDir,
    workspaceTitle: account.workspaceTitle,
    review: {
      ...account.review,
      commandAuthorAssociations: [...account.review.commandAuthorAssociations],
      models: account.review.models.map(model => ({ ...model })),
    },
  }
}

/** Resolve one settings value over composition-owned identity, authentication, URLs, and MCP fields. */
export function accountWithReviewerSettings(
  base: ResolvedAccountConfig,
  settings: ReviewerSettings,
): ResolvedAccountConfig {
  return normalizeAccountConfig({
    ...base,
    pollIntervalMs: settings.pollIntervalMs,
    repositories: settings.repositories,
    workspaceDir: settings.workspaceDir,
    workspaceTitle: settings.workspaceTitle,
    review: settings.review,
  })
}

/**
 * Resolve and validate a settings candidate before it is persisted or used to
 * replace a running reviewer runtime.
 */
export function validateReviewerSettings(base: ResolvedAccountConfig, settings: ReviewerSettings): void {
  const account = accountWithReviewerSettings(base, settings)
  validateAccountRuntime(account.name, account)
}

/**
 * Resolve the directory hosting this account's review-agent sessions: the
 * configured value when present, otherwise `$DSH_HOME/github-reviewer/<name>`.
 * @param configured - the configured `workspaceDir`, already trimmed.
 * @param name - resolved account name.
 */
function resolveWorkspaceDir(configured: string, name: string): string {
  if (configured !== '') return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'github-reviewer', name)
}

/**
 * Validate one account for review operation. Misconfiguration throws here at
 * plugin load, never silently skips a repo or account.
 * @param name - account name, for diagnostics.
 * @param account - normalized account config.
 */
export function validateAccountRuntime(name: string, account: ResolvedAccountConfig): void {
  // The auth mode is implicit: a configured personal access token selects PAT
  // mode, otherwise App mode. Reject a mix so a pasted token cannot silently
  // override (or be overridden by) App credentials.
  if (account.personalAccessToken !== '') {
    if (account.appId !== '' || account.installationId !== '' || account.privateKeyPath !== '') {
      throw new Error(
        `github-reviewer.${name}: personalAccessToken and the GitHub App credentials `
        + '(appId/installationId/privateKeyPath) are mutually exclusive; configure exactly one auth mode',
      )
    }
  } else {
    if (account.appId === '') throw new Error(`github-reviewer.${name}.appId is required`)
    if (account.installationId === '') throw new Error(`github-reviewer.${name}.installationId is required`)
    if (account.privateKeyPath === '') throw new Error(`github-reviewer.${name}.privateKeyPath is required`)
  }
  if (account.repositories.length === 0) {
    throw new Error(`github-reviewer.${name}.repositories must include at least one owner/repo`)
  }
  for (const repo of account.repositories) {
    if (parseRepository(repo) === undefined) {
      throw new Error(`github-reviewer.${name}.repositories entry "${repo}" must be owner/repo`)
    }
  }
  if (account.mcp.command === '') throw new Error(`github-reviewer.${name}.mcp.command is required`)
  if (account.mcp.args.length === 0) throw new Error(`github-reviewer.${name}.mcp.args is required`)
  validateHttpUrl(name, 'baseUrl', account.baseUrl, false)
  validateHttpUrl(name, 'webUrl', account.webUrl, true)
}

/** Assert a config URL is http(s); `allowEmpty` permits the empty string (feature disabled). */
function validateHttpUrl(name: string, field: string, value: string, allowEmpty: boolean): void {
  if (value === '') {
    if (allowEmpty) return
    throw new Error(`github-reviewer.${name}.${field} is required`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`github-reviewer.${name}.${field} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`github-reviewer.${name}.${field} must be http(s): ${value}`)
  }
}
