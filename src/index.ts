/**
 * `dsh-github-reviewer`: a DeepSeek Harness plugin that polls configured
 * GitHub repositories for open pull requests and posts automated COMMENT
 * reviews, ported from LingoBridge's GitHub platform and driven through the
 * harness agent loop: one live Agent per PR, one session log per PR, durable
 * through the harness session-persistence seam.
 *
 * The deployment must mount the agent-loop family (`agents`, `sessions`, and
 * — for restart-safe per-PR sessions — a `sessionPersistence` provider);
 * see README for the required composition rows.
 * @module @lingobridge/dsh-github-reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { AgentRunner } from './agent-runner.ts'
import { AppTokenSource } from './github/auth.ts'
import { GitHubClient } from './github/client.ts'
import { Config, normalizeAccountConfig, validateAccountRuntime } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { AccountPoller, cordisLogger } from './poller.ts'
import { JsonFileCursorStore } from './state-file.ts'

export { Config }
export type { Config as GithubReviewerConfig, AccountConfig, McpConfig, ResolvedAccountConfig, ReviewConfig } from './config.ts'
export type { ReviewGuardState, TurnSlot } from './github/guard.ts'
export type { PullRequest, Repository, ReviewInstructions } from './github/model.ts'
export type { TokenSource } from './github/auth.ts'
export type { ReviewDriver } from './poller.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github-reviewer'

/** Services required by this plugin: agent registry, session store, and the deployment-owned default model selection. */
export const inject = ['agents', 'sessions', 'agentDefaultModel']

/**
 * Start one poll loop per configured account. Each account's configuration
 * is validated and its private key loaded before activation: misconfiguration
 * fails the plugin at load instead of skipping reviews silently. One live
 * Agent per PR is created on first contact and resumed from session
 * persistence after a restart when a persistence provider is mounted.
 * @param ctx - plugin context carrying the agent registry and session store.
 * @param config - resolved plugin configuration.
 * @returns activation after every account has loaded its cursor state.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const sessionPersistence = ctx.get('sessionPersistence')
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
      const runner = new AgentRunner({
        accountName,
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentDefaultModel: ctx.agentDefaultModel,
        ...sessionPersistence === undefined ? {} : { sessionPersistence },
        tokenSource,
        logger,
      })
      const poller = new AccountPoller({
        accountName,
        account,
        client,
        tokenSource,
        store,
        driver: runner,
        logger,
      })
      poller.start()
      logger.info(`starting github account=${accountName} repos=${account.repositories.length} poll_interval_ms=${account.pollIntervalMs}`)
      return () => poller.dispose()
    }, `github-reviewer.${accountName}`)
  }
}
