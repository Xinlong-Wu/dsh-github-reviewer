/**
 * `dsh-github-reviewer`: a DeepSeek Harness plugin that polls configured
 * GitHub repositories for open pull requests and posts automated COMMENT
 * reviews, ported from LingoBridge's GitHub platform.
 *
 * Mount it in a harness `cordis.yml` composition with `accounts` config; each
 * account runs its own poll loop and per-review GitHub MCP server.
 * @module @lingobridge/dsh-github-reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { AppTokenSource } from './github/auth.ts'
import { GitHubClient } from './github/client.ts'
import { Config, normalizeAccountConfig, validateAccountRuntime } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { AccountPoller, cordisLogger } from './poller.ts'
import { JsonFileCursorStore } from './state-file.ts'

export { Config }
export type { Config as GithubReviewerConfig, AccountConfig, McpConfig, ResolvedAccountConfig, ReviewConfig } from './config.ts'
export type { GuardedTool, GuardedToolResult, ReviewGuardState } from './github/guard.ts'
export type { PullRequest, Repository, ReviewInstructions } from './github/model.ts'
export type { TokenSource } from './github/auth.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github-reviewer'

/** Services required by this plugin. */
export const inject = ['llm']

/**
 * Start one poll loop per configured account. Each account's configuration
 * is validated and its private key loaded before activation: misconfiguration
 * fails the plugin at load instead of skipping reviews silently.
 * @param ctx - plugin context carrying the `llm` service.
 * @param config - resolved plugin configuration.
 * @returns activation after every account has loaded its cursor state.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  for (const [accountName, rawAccount] of Object.entries(config.accounts)) {
    const account = normalizeAccountConfig(rawAccount)
    validateAccountRuntime(accountName, account)

    const tokenSource = await AppTokenSource.fromFile(
      account.appId,
      account.installationId,
      account.privateKeyPath,
      account.baseUrl,
    )
    const client = new GitHubClient(account.baseUrl, tokenSource)
    const store = new JsonFileCursorStore(
      account.statePath === '' ? JsonFileCursorStore.defaultPath(accountName) : account.statePath,
    )
    await store.load()

    const logger = cordisLogger(ctx.logger)
    ctx.effect(() => {
      const poller = new AccountPoller({
        accountName,
        account,
        llm: ctx.llm,
        client,
        tokenSource,
        store,
        logger,
      })
      poller.start()
      logger.info(`starting github account=${accountName} repos=${account.repositories.length} poll_interval_ms=${account.pollIntervalMs}`)
      return () => poller.dispose()
    }, `github-reviewer.${accountName}`)
  }
}
