/** Optional workspace registration coordinated across reviewer runtime generations. */

import { mkdir } from 'node:fs/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ResolvedAccountConfig } from './config.ts'
import type { PollLogger } from './logger.ts'

/** Serialize and coalesce durable workspace registrations for the current config. */
export class WorkspaceCoordinator {
  private registry: WorkspaceRegistry | undefined
  private lease: symbol | undefined
  private desired: ResolvedAccountConfig | undefined
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly attachedSessionIds = new Set<SessionId>()
  private revision = 0
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly logger: PollLogger) {}

  /** Attach the currently available registry and return its exact detach action. */
  attach(registry: WorkspaceRegistry): () => void {
    const lease = Symbol('github-reviewer-workspace')
    this.registry = registry
    this.lease = lease
    this.attachedSessionIds.clear()
    this.revision += 1
    this.schedule()
    return () => {
      if (this.lease !== lease) return
      this.registry = undefined
      this.lease = undefined
      this.revision += 1
    }
  }

  /** Register the workspace belonging to the latest committed runtime config. */
  request(config: ResolvedAccountConfig): void {
    if (this.closed) return
    if (this.desired?.workspaceDir !== config.workspaceDir) this.attachedSessionIds.clear()
    this.desired = config
    this.revision += 1
    this.schedule()
  }

  /** Account a live reviewer session under the workspace path of its runtime generation. */
  requestSession(sessionId: SessionId, workspaceDir: string): void {
    if (this.closed) return
    const priorPath = this.sessionPaths.get(sessionId)
    this.sessionPaths.set(sessionId, workspaceDir)
    if (priorPath !== workspaceDir) this.attachedSessionIds.delete(sessionId)
    if (this.attachedSessionIds.has(sessionId)) return
    this.revision += 1
    this.schedule()
  }

  /** Stop future durable registrations and wait for owned work to settle. */
  async dispose(): Promise<void> {
    this.closed = true
    this.registry = undefined
    this.lease = undefined
    this.desired = undefined
    this.sessionPaths.clear()
    this.attachedSessionIds.clear()
    this.revision += 1
    await this.tail
  }

  private schedule(): void {
    const revision = this.revision
    this.tail = this.tail.then(() => this.register(revision), () => this.register(revision))
  }

  private async register(revision: number): Promise<void> {
    const registry = this.registry
    const config = this.desired
    const lease = this.lease
    if (this.closed || registry === undefined || config === undefined || lease === undefined) return
    try {
      await mkdir(config.workspaceDir, { recursive: true })
    } catch (error) {
      this.logger.warn(`github reviewer workspace dir creation failed: ${String(error)}`)
      return
    }
    if (
      this.closed
      || this.revision !== revision
      || this.registry !== registry
      || this.lease !== lease
      || this.desired !== config
    ) return
    try {
      const workspace = await registry.create(config.workspaceDir, config.workspaceTitle)
      if (
        this.closed
        || this.revision !== revision
        || this.registry !== registry
        || this.lease !== lease
        || this.desired !== config
      ) return
      this.logger.info(`registered github reviewer workspace title=${config.workspaceTitle} dir=${config.workspaceDir}`)
      for (const [sessionId, workspaceDir] of this.sessionPaths) {
        if (workspaceDir !== config.workspaceDir || this.attachedSessionIds.has(sessionId)) continue
        if (
          this.closed
          || this.revision !== revision
          || this.registry !== registry
          || this.lease !== lease
          || this.desired !== config
        ) return
        try {
          await workspace.attachSession(sessionId)
          if (
            this.closed
            || this.revision !== revision
            || this.registry !== registry
            || this.lease !== lease
            || this.desired !== config
          ) return
          this.attachedSessionIds.add(sessionId)
          this.logger.info(`attached github reviewer session=${sessionId} workspace=${workspace.id}`)
        } catch (error) {
          this.logger.warn(`github reviewer workspace session attachment failed session=${sessionId}: ${String(error)}`)
        }
      }
    } catch (error) {
      this.logger.warn(`github reviewer workspace registration failed: ${String(error)}`)
    }
  }
}
