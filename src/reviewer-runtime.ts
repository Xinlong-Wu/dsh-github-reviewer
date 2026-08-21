/** One replaceable GitHub reviewer runtime generation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { AgentRunner } from './agent-runner.ts'
import type { ResolvedAccountConfig } from './config.ts'
import { cursorDomainSpec, StorageDomainCursorStore } from './cursor-store.ts'
import { AppTokenSource, StaticTokenSource } from './github/auth.ts'
import type { TokenSource } from './github/auth.ts'
import { GitHubClient } from './github/client.ts'
import type { PollLogger } from './logger.ts'
import type { AccessibleRepository } from './repository-catalog-contract.ts'
import { AccountPoller } from './poller.ts'

interface RuntimePluginConfig {
  account: ResolvedAccountConfig
  logger: PollLogger
  generation: number
  tokenSource: TokenSource
  client: GitHubClient
  onSessionReady: (sessionId: SessionId, workspaceDir: string) => void
}

interface RuntimeFiber {
  dispose(): Promise<void>
}

const RuntimePlugin = {
  name: 'github-reviewer-runtime',
  async apply(ctx: Context, options: RuntimePluginConfig): Promise<void> {
    const { account, logger, generation, tokenSource, client, onSessionReady } = options
    const domain = await ctx.storageDomain.open(cursorDomainSpec)
    try {
      const store = new StorageDomainCursorStore(domain.table('accounts'), account.name)
      await store.load()
      const sessionPersistence = ctx.get('sessionPersistence')
      const sessionTitle = ctx.get('sessionTitle')
      const llm = ctx.get('llm')
      const runner = new AgentRunner({
        accountName: account.name,
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentDefaultModel: ctx.agentDefaultModel,
        ...llm === undefined ? {} : { llm },
        ...sessionTitle === undefined ? {} : { sessionTitle },
        ...sessionPersistence === undefined ? {} : { sessionPersistence },
        onSessionReady: sessionId => { onSessionReady(sessionId, account.workspaceDir) },
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
      ctx.effect(() => {
        poller.start()
        logger.info(
          `starting github reviewer generation=${generation} account=${account.name}`
          + ` repos=${account.repositories.length} poll_interval_ms=${account.pollIntervalMs}`,
        )
        return async () => {
          await poller.dispose()
          await domain.close()
          logger.info(`stopped github reviewer generation=${generation} account=${account.name}`)
        }
      }, `github-reviewer.runtime.${account.name}.${generation}`)
    } catch (error) {
      await domain.close()
      throw error
    }
  },
}

/** A started runtime generation owned through one child Cordis fiber. */
export class ReviewerRuntime {
  private constructor(
    readonly config: ResolvedAccountConfig,
    readonly generation: number,
    private readonly fiber: RuntimeFiber,
    private readonly client: GitHubClient,
    private readonly catalogAuthentication: 'user' | 'installation',
  ) {}

  /** Start one fully initialized runtime generation. */
  static async start(
    ctx: Context,
    config: ResolvedAccountConfig,
    logger: PollLogger,
    generation: number,
    onSessionReady: (sessionId: SessionId, workspaceDir: string) => void,
  ): Promise<ReviewerRuntime> {
    const catalogAuthentication = config.personalAccessToken !== '' ? 'user' : 'installation'
    const tokenSource = config.personalAccessToken !== ''
      ? new StaticTokenSource(config.personalAccessToken)
      : await AppTokenSource.fromFile(
          config.appId,
          config.installationId,
          config.privateKeyPath,
          config.baseUrl,
        )
    const client = new GitHubClient(config.baseUrl, tokenSource)
    const fiber = await ctx.plugin(RuntimePlugin, {
      account: config,
      logger,
      generation,
      tokenSource,
      client,
      onSessionReady,
    })
    return new ReviewerRuntime(config, generation, fiber, client, catalogAuthentication)
  }

  /** List repositories visible to this committed runtime generation's credential. */
  async listAccessibleRepositories(signal?: AbortSignal): Promise<AccessibleRepository[]> {
    return await this.client.listAccessibleRepositories(this.catalogAuthentication, signal)
  }

  /** Stop the runtime and wait until every owned resource is quiescent. */
  dispose(): Promise<void> {
    return this.fiber.dispose()
  }
}
