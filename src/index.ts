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
 * @module @xinlongwu/dsh-github-reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { AgentRunner } from './agent-runner.ts'
import { AppTokenSource, StaticTokenSource } from './github/auth.ts'
import { GitHubClient } from './github/client.ts'
import { Config, normalizeAccountConfig, validateAccountRuntime } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { cursorDomainSpec, StorageDomainCursorStore } from './cursor-store.ts'
import { AccountPoller, cordisLogger } from './poller.ts'

export { Config }
export type { Config as GithubReviewerConfig, McpConfig, ResolvedAccountConfig, ReviewConfig } from './config.ts'
export type { ReviewGuardState, TurnSlot } from './github/guard.ts'
export type { PullRequest, Repository, ReviewInstructions } from './github/model.ts'
export { StaticTokenSource }
export type { TokenSource } from './github/auth.ts'
export type { ReviewDriver } from './poller.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github-reviewer'

/** Services required by this plugin: agent registry, session store, deployment-owned default model, and the storage domain. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'storageDomain']

/** Account names currently active in this process, to catch duplicate-instance misconfiguration. */
const activeAccounts = new Set<string>()

/**
 * Start the poll loop for this instance's account (mount the plugin once per
 * account). The account's configuration is validated and its private key
 * loaded before activation: misconfiguration fails the plugin at load instead
 * of skipping reviews silently. One live Agent per PR is created on first
 * contact and resumed from session persistence after a restart when a
 * persistence provider is mounted.
 * @param ctx - plugin context carrying the agent registry and session store.
 * @param config - resolved plugin configuration for this account.
 * @returns activation after the account's cursor state has loaded.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const account = normalizeAccountConfig(config)
  validateAccountRuntime(account.name, account)
  if (activeAccounts.has(account.name)) {
    throw new Error(
      `github-reviewer.${account.name} is already active in this process; `
      + 'two instances with the same account name would share one cursor record',
    )
  }

  // PAT mode needs no key file; App mode validates the private key eagerly so
  // a bad key fails at load, not on the first review.
  const tokenSource = account.personalAccessToken !== ''
    ? new StaticTokenSource(account.personalAccessToken)
    : await AppTokenSource.fromFile(
      account.appId,
      account.installationId,
      account.privateKeyPath,
      account.baseUrl,
    )
  const client = new GitHubClient(account.baseUrl, tokenSource)
  const domain = await ctx.storageDomain.open(cursorDomainSpec)
  try {
    const store = new StorageDomainCursorStore(domain.table('accounts'), account.name)
    await store.load()

    const logger = cordisLogger(ctx.logger)

    // Register the account's review-session directory as a harness workspace
    // when the deployment mounts the `workspace` service (the web profile
    // does): review-agent sessions carry this directory as their cwd, so they
    // group under the workspace title instead of the ungrouped bucket. This
    // is best-effort — a registration failure only degrades session grouping.
    const workspace = ctx.get('workspace')
    if (workspace !== undefined) {
      try {
        await mkdir(account.workspaceDir, { recursive: true })
        await workspace.create(account.workspaceDir, account.workspaceTitle)
        logger.info(`registered github reviewer workspace title=${account.workspaceTitle} dir=${account.workspaceDir}`)
      } catch (error) {
        logger.warn(`github reviewer workspace registration failed: ${String(error)}`)
      }
    }
    ctx.effect(() => {
      // Read the optional persistence service inside the effect so the wiring
      // does not depend on plugin mount order at apply time.
      const sessionPersistence = ctx.get('sessionPersistence')
      const runner = new AgentRunner({
        accountName: account.name,
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentDefaultModel: ctx.agentDefaultModel,
        ...sessionPersistence === undefined ? {} : { sessionPersistence },
        tokenSource,
        logger,
      })
      const poller = new AccountPoller({
        accountName: account.name,
        account,
        client,
        tokenSource,
        store,
        driver: runner,
        logger,
      })
      poller.start()
      activeAccounts.add(account.name)
      logger.info(`starting github account=${account.name} repos=${account.repositories.length} poll_interval_ms=${account.pollIntervalMs}`)
      return async () => {
        activeAccounts.delete(account.name)
        await poller.dispose()
        await domain.close()
      }
    }, `github-reviewer.${account.name}`)
  } catch (error) {
    await domain.close()
    throw error
  }
}
