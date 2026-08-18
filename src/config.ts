/**
 * Plugin configuration: one GitHub App review account per entry under
 * `accounts`. Ported from LingoBridge's `platforms.github` config with the
 * harness model route split into `provider` + `model`.
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { parseRepository } from './github/model.ts'

/** Defaults shared with LingoBridge. */
export const DEFAULT_BASE_URL = 'https://api.github.com'
export const DEFAULT_WEB_URL = 'https://github.com'
export const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000
export const DEFAULT_MAX_TOOL_CALLS = 30
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000
export const DEFAULT_TOOL_RESULT_LIMIT = 60_000
/** Overall deadline for one review conversation. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60_000

/** Per-account review limits, fully resolved after normalization. */
export interface ReviewConfig {
  maxToolCalls: number
  toolTimeoutMs: number
  toolResultLimit: number
  /** Overall deadline for one review conversation in milliseconds. */
  timeoutMs: number
  defaultInstructions: string
}

/** Per-review GitHub MCP server spawn parameters, fully resolved after normalization. */
export interface McpConfig {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** One GitHub App review account as loaded from cordis.yml. */
export interface AccountConfig {
  appId: string
  installationId: string
  privateKeyPath: string
  baseUrl: string
  webUrl: string
  pollIntervalMs: number
  repositories: string[]
  provider: string
  model: string
  /** Optional; defaults are materialized by {@link normalizeAccountConfig}. */
  review?: ReviewConfig
  /** Optional; the command and args are required for review operation. */
  mcp?: McpConfig
  /** Optional cursor state file; defaults to `./.dsh-github-reviewer/<account>.json`. */
  statePath: string
}

/** One GitHub App review account with every default resolved. */
export interface ResolvedAccountConfig {
  appId: string
  installationId: string
  privateKeyPath: string
  baseUrl: string
  webUrl: string
  pollIntervalMs: number
  repositories: string[]
  provider: string
  model: string
  review: ReviewConfig
  mcp: McpConfig
  statePath: string
}

/** Whole plugin configuration. */
export interface Config {
  accounts: Record<string, AccountConfig>
}

const Review = z.object({
  maxToolCalls: z.number().min(1).default(DEFAULT_MAX_TOOL_CALLS),
  toolTimeoutMs: z.number().min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  toolResultLimit: z.number().min(1).default(DEFAULT_TOOL_RESULT_LIMIT),
  timeoutMs: z.number().min(1).default(DEFAULT_REVIEW_TIMEOUT_MS),
  defaultInstructions: z.string().default(''),
})

const Mcp = z.object({
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string().default(''),
})

const Account = z.object({
  appId: z.string().default(''),
  installationId: z.string().default(''),
  privateKeyPath: z.string().default(''),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  webUrl: z.string().default(DEFAULT_WEB_URL),
  pollIntervalMs: z.number().min(1000).default(DEFAULT_POLL_INTERVAL_MS),
  repositories: z.array(z.string()).default([]),
  provider: z.string().default('deepseek'),
  model: z.string().default(''),
  review: Review,
  mcp: Mcp,
  statePath: z.string().default(''),
})

/** Schemastery schema for cordis.yml loading. */
export const Config = z.object({
  accounts: z.dict(Account).default({}),
}) as unknown as z<Config>

/**
 * Normalize one account config: trim strings, dedupe repositories, and
 * materialize review/MCP defaults the schema leaves optional.
 * @param account - raw account config.
 * @returns normalized account config with every default resolved.
 */
export function normalizeAccountConfig(account: AccountConfig): ResolvedAccountConfig {
  const repositories: string[] = []
  const seen = new Set<string>()
  for (const raw of account.repositories) {
    const parsed = parseRepository(raw)
    const value = parsed === undefined ? raw.trim() : `${parsed.owner}/${parsed.name}`
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    repositories.push(value)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(account.mcp?.env ?? {})) {
    const trimmed = key.trim()
    if (trimmed !== '') env[trimmed] = value
  }
  const args = (account.mcp?.args ?? []).map(value => value.trim()).filter(value => value !== '')
  return {
    appId: account.appId.trim(),
    installationId: account.installationId.trim(),
    privateKeyPath: account.privateKeyPath.trim(),
    baseUrl: account.baseUrl.trim().replace(/\/+$/, ''),
    webUrl: account.webUrl.trim().replace(/\/+$/, ''),
    pollIntervalMs: account.pollIntervalMs,
    repositories,
    provider: account.provider.trim(),
    model: account.model.trim(),
    review: {
      maxToolCalls: account.review?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      toolTimeoutMs: account.review?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      toolResultLimit: account.review?.toolResultLimit ?? DEFAULT_TOOL_RESULT_LIMIT,
      timeoutMs: account.review?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      defaultInstructions: (account.review?.defaultInstructions ?? '').trim(),
    },
    mcp: {
      command: (account.mcp?.command ?? '').trim(),
      args,
      env,
      cwd: (account.mcp?.cwd ?? '').trim(),
    },
    statePath: account.statePath.trim(),
  }
}

/**
 * Validate one account for review operation. Misconfiguration throws here at
 * plugin load, never silently skips a repo or account.
 * @param name - account name, for diagnostics.
 * @param account - normalized account config.
 */
export function validateAccountRuntime(name: string, account: ResolvedAccountConfig): void {
  if (account.appId === '') throw new Error(`github-reviewer.accounts.${name}.appId is required`)
  if (account.installationId === '') throw new Error(`github-reviewer.accounts.${name}.installationId is required`)
  if (account.privateKeyPath === '') throw new Error(`github-reviewer.accounts.${name}.privateKeyPath is required`)
  if (account.repositories.length === 0) {
    throw new Error(`github-reviewer.accounts.${name}.repositories must include at least one owner/repo`)
  }
  for (const repo of account.repositories) {
    if (parseRepository(repo) === undefined) {
      throw new Error(`github-reviewer.accounts.${name}.repositories entry "${repo}" must be owner/repo`)
    }
  }
  if (account.provider === '') throw new Error(`github-reviewer.accounts.${name}.provider is required`)
  if (account.model === '') throw new Error(`github-reviewer.accounts.${name}.model is required`)
  if (account.mcp.command === '') throw new Error(`github-reviewer.accounts.${name}.mcp.command is required`)
  if (account.mcp.args.length === 0) throw new Error(`github-reviewer.accounts.${name}.mcp.args is required`)
}
