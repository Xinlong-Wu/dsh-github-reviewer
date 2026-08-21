/** Optional workspace registration coordinated across reviewer runtime generations. */

import { mkdir, realpath } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { isReviewerSessionKey } from './session-key.ts'
import type { ResolvedAccountConfig } from './config.ts'
import type { PollLogger } from './logger.ts'

/** One historical Session scan and whether durable persistence participated successfully. */
export interface ExistingSessionScan {
  headers: readonly SessionHeader[]
  complete: boolean
}

/** Read existing live and persisted Session headers without making persistence a required dependency. */
export type ExistingSessionHeaders = (signal: AbortSignal) => Promise<ExistingSessionScan>

/** Serialize and coalesce durable workspace registrations for the current config. */
export class WorkspaceCoordinator {
  private registry: WorkspaceRegistry | undefined
  private lease: symbol | undefined
  private desired: ResolvedAccountConfig | undefined
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly attachedSessionIds = new Set<SessionId>()
  private discoveredWorkspacePath: string | undefined
  private currentWorkspaceId: string | undefined
  private discoveryAbort: AbortController | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private revision = 0
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly logger: PollLogger,
    private readonly existingSessionHeaders: ExistingSessionHeaders = async () => ({ headers: [], complete: true }),
    private readonly retryBaseDelayMs = 1_000,
  ) {}

  /** Attach the currently available registry and return its exact detach action. */
  attach(registry: WorkspaceRegistry): () => void {
    const lease = Symbol('github-reviewer-workspace')
    this.registry = registry
    this.lease = lease
    this.attachedSessionIds.clear()
    this.discoveredWorkspacePath = undefined
    this.currentWorkspaceId = undefined
    this.discoveryAbort?.abort()
    this.discoveryAbort = undefined
    this.revision += 1
    this.schedule()
    return () => {
      if (this.lease !== lease) return
      this.registry = undefined
      this.lease = undefined
      this.currentWorkspaceId = undefined
      this.discoveryAbort?.abort()
      this.discoveryAbort = undefined
      this.revision += 1
    }
  }

  /** Register the workspace belonging to the latest committed runtime config. */
  request(config: ResolvedAccountConfig): void {
    if (this.closed) return
    if (this.desired?.workspaceDir !== config.workspaceDir) {
      this.attachedSessionIds.clear()
      this.discoveredWorkspacePath = undefined
      this.currentWorkspaceId = undefined
      this.discoveryAbort?.abort()
      this.discoveryAbort = undefined
    }
    this.desired = config
    this.revision += 1
    this.schedule()
  }

  /** Rescan persisted headers after the optional persistence service appears or changes. */
  refreshExistingSessions(): void {
    if (this.closed) return
    this.discoveredWorkspacePath = undefined
    this.discoveryAbort?.abort()
    this.discoveryAbort = undefined
    this.revision += 1
    this.schedule()
  }

  /** Account a live reviewer session under the workspace path of its runtime generation. */
  requestSession(sessionId: SessionId, workspaceDir: string): void {
    if (this.closed) return
    const priorPath = this.sessionPaths.get(sessionId)
    this.sessionPaths.set(sessionId, workspaceDir)
    if (priorPath !== workspaceDir) this.attachedSessionIds.delete(sessionId)
    if (!this.attachedSessionIds.has(sessionId)) {
      this.discoveryAbort?.abort()
      this.discoveryAbort = undefined
    }
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
    this.discoveredWorkspacePath = undefined
    this.currentWorkspaceId = undefined
    this.discoveryAbort?.abort()
    this.discoveryAbort = undefined
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.revision += 1
    await this.tail
  }

  private schedule(): void {
    const revision = this.revision
    this.tail = this.tail.then(() => this.register(revision), () => this.register(revision))
  }

  private updateRetry(complete: boolean): void {
    if (complete) {
      this.retryAttempt = 0
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      return
    }
    if (this.closed || this.retryTimer !== undefined) return
    const delay = Math.min(this.retryBaseDelayMs * 2 ** this.retryAttempt, 30_000)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.closed) return
      this.revision += 1
      this.schedule()
    }, delay)
  }

  private owns(
    revision: number,
    registry: WorkspaceRegistry,
    lease: symbol,
    config: ResolvedAccountConfig,
  ): boolean {
    return !this.closed
      && this.revision === revision
      && this.registry === registry
      && this.lease === lease
      && this.desired === config
  }

  private async discoverExistingSessions(
    workspace: Workspace,
    config: ResolvedAccountConfig,
    revision: number,
    registry: WorkspaceRegistry,
    lease: symbol,
  ): Promise<boolean> {
    if (this.discoveredWorkspacePath === workspace.path) return true
    const abort = new AbortController()
    this.discoveryAbort = abort
    let scan: ExistingSessionScan
    try {
      scan = await this.existingSessionHeaders(abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger.warn(`github reviewer existing session discovery failed: ${String(error)}`)
      }
      return false
    } finally {
      if (this.discoveryAbort === abort) this.discoveryAbort = undefined
    }
    if (abort.signal.aborted || !this.owns(revision, registry, lease, config)) return false
    for (const header of scan.headers) {
      if (!isReviewerSessionKey(config.name, String(header.id)) || header.cwd === undefined) continue
      let canonical: string
      try {
        canonical = await realpath(header.cwd)
      } catch {
        continue
      }
      if (!this.owns(revision, registry, lease, config)) return false
      if (canonical !== workspace.path) continue
      this.sessionPaths.set(header.id, config.workspaceDir)
      this.attachedSessionIds.delete(header.id)
    }
    if (scan.complete) this.discoveredWorkspacePath = workspace.path
    return scan.complete
  }

  private async attachPendingSessions(
    workspace: Workspace,
    config: ResolvedAccountConfig,
    revision: number,
    registry: WorkspaceRegistry,
    lease: symbol,
  ): Promise<boolean> {
    let complete = true
    for (const [sessionId, workspaceDir] of this.sessionPaths) {
      if (workspaceDir !== config.workspaceDir || this.attachedSessionIds.has(sessionId)) continue
      if (!this.owns(revision, registry, lease, config)) return false
      try {
        await workspace.attachSession(sessionId)
        if (!this.owns(revision, registry, lease, config)) return false
        this.attachedSessionIds.add(sessionId)
        this.logger.info(`attached github reviewer session=${sessionId} workspace=${workspace.id}`)
      } catch (error) {
        complete = false
        this.logger.warn(`github reviewer workspace session attachment failed session=${sessionId}: ${String(error)}`)
      }
    }
    return complete
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
      if (this.currentWorkspaceId !== workspace.id) {
        this.currentWorkspaceId = workspace.id
        this.attachedSessionIds.clear()
        this.discoveredWorkspacePath = undefined
      }
      this.logger.info(`registered github reviewer workspace title=${config.workspaceTitle} dir=${config.workspaceDir}`)
      await this.attachPendingSessions(workspace, config, revision, registry, lease)
      if (!this.owns(revision, registry, lease, config)) return
      const discoveryComplete = await this.discoverExistingSessions(workspace, config, revision, registry, lease)
      if (!this.owns(revision, registry, lease, config)) return
      const attachmentComplete = await this.attachPendingSessions(workspace, config, revision, registry, lease)
      if (!this.owns(revision, registry, lease, config)) return
      this.updateRetry(discoveryComplete && attachmentComplete)
    } catch (error) {
      this.logger.warn(`github reviewer workspace registration failed: ${String(error)}`)
    }
  }
}
