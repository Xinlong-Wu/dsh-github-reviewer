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
export type { Config as GithubReviewerConfig, McpConfig, ResolvedAccountConfig, ReviewConfig, ReviewModel } from './config.ts'
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

    ctx.effect(() => {
      // Read the optional services inside the effect so the wiring does not
      // depend on plugin mount order at apply time.
      const sessionPersistence = ctx.get('sessionPersistence')
      const sessionTitle = ctx.get('sessionTitle')
      const llm = ctx.get('llm')

      // Before any PR session is created, make sure the review-session
      // directory exists and — when the workspace service is available — the
      // directory is registered as a harness workspace. Lazy reads inside the
      // closure keep this free of the activation race.
      const ensureWorkspace = async (): Promise<void> => {
        try {
          await mkdir(account.workspaceDir, { recursive: true })
        } catch (error) {
          logger.warn(`github reviewer workspace dir creation failed: ${String(error)}`)
        }
        const workspace = ctx.get('workspace')
        if (workspace === undefined) return
        try {
          await workspace.create(account.workspaceDir, account.workspaceTitle)
        } catch (error) {
          logger.warn(`github reviewer workspace registration failed: ${String(error)}`)
        }
      }

      const runner = new AgentRunner({
        accountName: account.name,
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentDefaultModel: ctx.agentDefaultModel,
        ...llm === undefined ? {} : { llm },
        ...sessionTitle === undefined ? {} : { sessionTitle },
        ...sessionPersistence === undefined ? {} : { sessionPersistence },
        ensureWorkspace,
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

      // Eager workspace registration: only when the composition actually
      // declares the `workspace` service (checked via the loader, so the
      // decision does not depend on activation order). The service can take
      // tens of seconds to activate (it scans the session store during init),
      // so a declared service is retried every 2s until it appears — no give
      // up window, since the composition guarantees it is coming. An unknown
      // presence (no loader, e.g. bare test contexts) keeps the current
      // bounded retry as a fallback. Aborts on dispose.
      const workspaceAbort = new AbortController()
      const presence = workspacePresence(ctx)
      if (presence !== 'not-declared') {
        void (async () => {
          const giveUpAt = presence === 'unknown' ? 300 : Number.POSITIVE_INFINITY
          try {
            await mkdir(account.workspaceDir, { recursive: true })
          } catch (error) {
            logger.warn(`github reviewer workspace dir creation failed: ${String(error)}`)
          }
          for (let attempt = 0; attempt < giveUpAt && !workspaceAbort.signal.aborted; attempt++) {
            const workspace = ctx.get('workspace')
            if (workspace !== undefined) {
              try {
                await workspace.create(account.workspaceDir, account.workspaceTitle)
                logger.info(`registered github reviewer workspace title=${account.workspaceTitle} dir=${account.workspaceDir}`)
              } catch (error) {
                logger.warn(`github reviewer workspace registration failed: ${String(error)}`)
              }
              return
            }
            if (attempt === 0) logger.debug('workspace service not yet available; retrying registration')
            await delay(2000, workspaceAbort.signal)
          }
          logger.debug('workspace service did not appear; review sessions stay ungrouped')
        })()
      }

      return async () => {
        workspaceAbort.abort()
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

/** Resolve after `ms` milliseconds, or immediately when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort)
  })
}

/**
 * Whether the `workspace` service is part of the composition, decided from the
 * loader (which knows every entry before activation): `declared` when a
 * non-disabled entry provides it, `not-declared` when it is absent, and
 * `unknown` when the loader is not mounted (e.g. bare test contexts). This is
 * deterministic at activation time, unlike `ctx.get('workspace')`, which races
 * the service's slow init.
 */
function workspacePresence(ctx: Context): 'declared' | 'not-declared' | 'unknown' {
  const loader = ctx.get('loader')
  if (loader === undefined) return 'unknown'
  for (const entry of loader.entries()) {
    if (entry.disabled) continue
    if (entry.options.id === 'workspace' || entry.options.name === '@deepseek-ai/dsh-workspace') {
      return 'declared'
    }
  }
  return 'not-declared'
}
