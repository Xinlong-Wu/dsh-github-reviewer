/**
 * `dsh-github-reviewer`: a DeepSeek Harness plugin that polls configured
 * GitHub repositories for open pull requests and posts automated COMMENT
 * reviews through one persistent harness Agent and session per PR.
 * @module dsh-github-reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  accountWithReviewerSettings,
  Config,
  normalizeAccountConfig,
  ReviewerSettingsSchema,
  reviewerSettingsOf,
  validateAccountRuntime,
  validateReviewerSettings,
} from './config.ts'
import type { Config as PluginConfig, ReviewerSettings } from './config.ts'
import { StaticTokenSource } from './github/auth.ts'
import { cordisLogger } from './poller.ts'
import { ReviewerRestartController } from './restart-controller.ts'
import { WorkspaceCoordinator } from './workspace-coordinator.ts'

export { Config }
export type {
  Config as GithubReviewerConfig,
  McpConfig,
  ResolvedAccountConfig,
  ReviewConfig,
  ReviewerSettings,
  ReviewModel,
} from './config.ts'
export type { ReviewGuardState, TurnSlot } from './github/guard.ts'
export type { PullRequest, Repository, ReviewInstructions } from './github/model.ts'
export { StaticTokenSource }
export type { TokenSource } from './github/auth.ts'
export type { ReviewDriver } from './poller.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github-reviewer'

/** Required core services; settings and workspace remain optional companions. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'storageDomain']

/** Fixed namespace owned by the one instance opting into the Web settings card. */
export const GITHUB_REVIEWER_SETTINGS_NAMESPACE = settingsNamespace('github-reviewer')

/** Account-name leases prevent concurrent instances from sharing cursor/session identities. */
const activeAccounts = new Map<string, symbol>()

function acquireAccount(name: string): symbol {
  if (activeAccounts.has(name)) {
    throw new Error(
      `github-reviewer.${name} is already active in this process; `
      + 'two instances with the same account name would share cursor and session identities',
    )
  }
  const lease = Symbol(name)
  activeAccounts.set(name, lease)
  return lease
}

function releaseAccount(name: string, lease: symbol): void {
  if (activeAccounts.get(name) === lease) activeAccounts.delete(name)
}

/**
 * Start the composition-configured runtime, then attach optional settings and
 * workspace companions without making either service a core dependency.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const baseAccount = normalizeAccountConfig(config)
  validateAccountRuntime(baseAccount.name, baseAccount)
  const accountLease = acquireAccount(baseAccount.name)
  const logger = cordisLogger(ctx.logger)
  const workspace = new WorkspaceCoordinator(logger)
  const controller = ReviewerRestartController.production(
    ctx,
    logger,
    account => { workspace.request(account) },
    (sessionId, workspaceDir) => { workspace.requestSession(sessionId, workspaceDir) },
  )
  let installed = false

  try {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
      const detach = workspace.attach(workspaceCtx.workspaceRegistry)
      return detach
    })

    await controller.start(baseAccount)

    if (baseAccount.uiSettings) {
      let source: () => ReviewerSettings = () => reviewerSettingsOf(baseAccount)
      installSettingsSection(
        ctx,
        GITHUB_REVIEWER_SETTINGS_NAMESPACE,
        ReviewerSettingsSchema,
        reviewerSettingsOf(baseAccount),
        {
          validate: value => { validateReviewerSettings(baseAccount, value) },
          setSource: current => { source = current },
          onChange: () => {
            try {
              controller.request(accountWithReviewerSettings(baseAccount, source()))
            } catch (error) {
              logger.warn(`github reviewer settings resolution failed: ${String(error)}`)
            }
          },
        },
      )
    }

    ctx.effect(() => async () => {
      await controller.dispose()
      await workspace.dispose()
      releaseAccount(baseAccount.name, accountLease)
    }, `github-reviewer.${baseAccount.name}`)
    installed = true
  } finally {
    if (!installed) {
      await controller.dispose()
      await workspace.dispose()
      releaseAccount(baseAccount.name, accountLease)
    }
  }
}
