/** Serialized replacement and rollback of one account's reviewer runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedAccountConfig } from './config.ts'
import type { PollLogger } from './logger.ts'
import { ReviewerRuntime } from './reviewer-runtime.ts'

/** Runtime face used by the controller and its deterministic tests. */
export interface RestartableReviewerRuntime {
  readonly config: ResolvedAccountConfig
  readonly generation: number
  dispose(): Promise<void>
}

/** Factory seam for runtime startup. */
export type ReviewerRuntimeFactory = (
  config: ResolvedAccountConfig,
  generation: number,
) => Promise<RestartableReviewerRuntime>

function sameConfig(left: ResolvedAccountConfig | undefined, right: ResolvedAccountConfig): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Own one committed runtime and serialize settings-driven stop/start
 * transitions. Requests arriving during a transition collapse to the latest
 * desired configuration.
 */
export class ReviewerRestartController {
  private current: RestartableReviewerRuntime | undefined
  private desired: ResolvedAccountConfig | undefined
  private drainPromise: Promise<void> | undefined
  private generation = 0
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly factory: ReviewerRuntimeFactory,
    private readonly logger: PollLogger,
    private readonly onCommit: (config: ResolvedAccountConfig) => void = () => {},
  ) {}

  /** Construct the production controller for one outer plugin fiber. */
  static production(
    ctx: Context,
    logger: PollLogger,
    onCommit: (config: ResolvedAccountConfig) => void,
    onSessionReady: (sessionId: SessionId, workspaceDir: string) => void,
  ): ReviewerRestartController {
    return new ReviewerRestartController(
      (config, generation) => ReviewerRuntime.start(ctx, config, logger, generation, onSessionReady),
      logger,
      onCommit,
    )
  }

  /** Start the initial runtime; composition startup failures reject activation. */
  async start(config: ResolvedAccountConfig): Promise<void> {
    if (this.closed) throw new Error('github reviewer restart controller is disposed')
    if (this.current !== undefined) throw new Error('github reviewer runtime is already started')
    const generation = ++this.generation
    this.current = await this.factory(config, generation)
    this.onCommit(config)
  }

  /** Schedule a non-throwing replacement to the latest resolved settings. */
  request(config: ResolvedAccountConfig): void {
    if (this.closed || sameConfig(this.current?.config, config)) return
    this.desired = config
    if (this.drainPromise !== undefined) return
    const drain = this.drain().catch((error: unknown) => {
      this.logger.warn(`github reviewer runtime transition failed: ${String(error)}`)
    })
    this.drainPromise = drain
    void drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = undefined
      if (!this.closed && this.desired !== undefined) this.request(this.desired)
    })
  }

  /** Stop pending replacement work and dispose the committed runtime. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.desired = undefined
    this.disposal = (async () => {
      await this.drainPromise
      const runtime = this.current
      this.current = undefined
      if (runtime !== undefined) await runtime.dispose()
    })()
    return this.disposal
  }

  /** Current committed config, exposed for workspace coordination and tests. */
  currentConfig(): ResolvedAccountConfig | undefined {
    return this.current?.config
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.desired !== undefined) {
      const target = this.desired
      this.desired = undefined
      if (sameConfig(this.current?.config, target)) continue
      const previous = this.current
      this.current = undefined
      if (previous !== undefined) await previous.dispose()
      if (this.closed) return
      try {
        const candidate = await this.factory(target, ++this.generation)
        if (this.closed) {
          await candidate.dispose()
          return
        }
        this.current = candidate
        this.onCommit(target)
      } catch (error) {
        this.logger.warn(`github reviewer runtime restart failed: ${String(error)}`)
        if (previous === undefined || this.closed) continue
        try {
          const rollback = await this.factory(previous.config, ++this.generation)
          if (this.closed) {
            await rollback.dispose()
            return
          }
          this.current = rollback
          this.onCommit(previous.config)
          this.logger.warn('github reviewer runtime restored the previous configuration')
        } catch (rollbackError) {
          this.logger.warn(`github reviewer runtime rollback failed: ${String(rollbackError)}`)
        }
      }
    }
  }
}
