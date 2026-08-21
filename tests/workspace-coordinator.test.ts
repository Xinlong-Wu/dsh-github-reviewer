import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ResolvedAccountConfig } from '../src/config.ts'
import { silentLogger } from '../src/logger.ts'
import { WorkspaceCoordinator } from '../src/workspace-coordinator.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'github-reviewer-workspace-'))
  dirs.push(root)
  const workspaceDir = join(root, 'reviewer')
  const attachedSessionIds: SessionId[] = []
  const attachSession = vi.fn(async (sessionId: SessionId) => {
    if (!attachedSessionIds.includes(sessionId)) attachedSessionIds.unshift(sessionId)
  })
  const workspace = {
    id: 'github-reviewer-workspace',
    path: workspaceDir,
    get sessionIds() { return attachedSessionIds },
    attachSession,
  } as unknown as Workspace
  const create = vi.fn(async () => workspace)
  const registry = { create } as unknown as WorkspaceRegistry
  const config = { name: 'reviewer', workspaceDir, workspaceTitle: 'GithubReviewer' } as ResolvedAccountConfig
  return { workspaceDir, workspace, attachSession, create, registry, config }
}

describe('WorkspaceCoordinator session accounting', () => {
  it('discovers and attaches only existing sessions owned by this reviewer and workspace path', async () => {
    const state = await fixture()
    const otherDir = join(state.workspaceDir, 'other')
    await mkdir(otherDir, { recursive: true })
    const matching = SessionId('github:reviewer:owner:repo:pr:7')
    const headers = [
      { id: matching, cwd: state.workspaceDir },
      { id: SessionId('github:other:owner:repo:pr:8'), cwd: state.workspaceDir },
      { id: SessionId('github:reviewer:manual-session'), cwd: state.workspaceDir },
      { id: SessionId('github:reviewer:owner:repo:pr:9'), cwd: otherDir },
      { id: SessionId('ordinary-session'), cwd: state.workspaceDir },
    ] as SessionHeader[]
    const coordinator = new WorkspaceCoordinator(silentLogger(), async () => ({ headers, complete: true }))
    const detach = coordinator.attach(state.registry)

    coordinator.request(state.config)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledOnce())
    expect(state.attachSession).toHaveBeenCalledWith(matching)
    expect(state.workspace.sessionIds).toEqual([matching])

    detach()
    await coordinator.dispose()
  })

  it('rescans existing sessions after an incomplete live-only discovery', async () => {
    const state = await fixture()
    const matching = SessionId('github:reviewer:owner:repo:pr:10')
    let persistenceReady = false
    const scan = vi.fn(async () => persistenceReady
      ? { headers: [{ id: matching, cwd: state.workspaceDir }] as SessionHeader[], complete: true }
      : { headers: [], complete: false })
    const coordinator = new WorkspaceCoordinator(silentLogger(), scan)
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    await vi.waitFor(() => expect(scan).toHaveBeenCalled())
    expect(state.attachSession).not.toHaveBeenCalled()

    persistenceReady = true
    coordinator.refreshExistingSessions()

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledWith(matching))
    detach()
    await coordinator.dispose()
  })

  it('autonomously retries an incomplete persisted-session scan', async () => {
    const state = await fixture()
    const matching = SessionId('github:reviewer:owner:repo:pr:13')
    const scan = vi.fn()
      .mockResolvedValueOnce({ headers: [], complete: false })
      .mockResolvedValue({ headers: [{ id: matching, cwd: state.workspaceDir }] as SessionHeader[], complete: true })
    const coordinator = new WorkspaceCoordinator(silentLogger(), scan, 1)
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)

    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
    expect(state.attachSession).toHaveBeenCalledWith(matching)

    detach()
    await coordinator.dispose()
  })

  it('preempts slow historical discovery so a new live session attaches first', async () => {
    const state = await fixture()
    const scan = vi.fn(async (signal: AbortSignal) => await new Promise<{ headers: SessionHeader[]; complete: boolean }>((resolve) => {
      signal.addEventListener('abort', () => { resolve({ headers: [], complete: false }) }, { once: true })
    }))
    const coordinator = new WorkspaceCoordinator(silentLogger(), scan)
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())

    const live = SessionId('github:reviewer:owner:repo:pr:11')
    coordinator.requestSession(live, state.workspaceDir)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledWith(live))
    detach()
    await coordinator.dispose()
  })

  it('attaches a queued reviewer session when the optional registry appears later', async () => {
    const state = await fixture()
    const coordinator = new WorkspaceCoordinator(silentLogger())

    coordinator.request(state.config)
    coordinator.requestSession(SessionId('github:reviewer:owner:repo:pr:1'), state.workspaceDir)
    const detach = coordinator.attach(state.registry)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledOnce())
    expect(state.create).toHaveBeenCalledWith(state.workspaceDir, 'GithubReviewer')
    expect(state.attachSession).toHaveBeenCalledWith('github:reviewer:owner:repo:pr:1')
    expect(state.workspace.sessionIds).toContain('github:reviewer:owner:repo:pr:1')

    detach()
    await coordinator.dispose()
  })

  it('reattaches known sessions when the Workspace is recreated at the same path', async () => {
    const state = await fixture()
    const secondSessionIds: SessionId[] = []
    const secondAttach = vi.fn(async (sessionId: SessionId) => { secondSessionIds.unshift(sessionId) })
    const secondWorkspace = {
      id: 'github-reviewer-workspace-recreated',
      path: state.workspaceDir,
      get sessionIds() { return secondSessionIds },
      attachSession: secondAttach,
    } as unknown as Workspace
    let activeWorkspace = state.workspace
    state.create.mockImplementation(async () => activeWorkspace)
    const coordinator = new WorkspaceCoordinator(silentLogger())
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    const sessionId = SessionId('github:reviewer:owner:repo:pr:12')
    coordinator.requestSession(sessionId, state.workspaceDir)
    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledWith(sessionId))

    activeWorkspace = secondWorkspace
    coordinator.requestSession(sessionId, state.workspaceDir)

    await vi.waitFor(() => expect(secondAttach).toHaveBeenCalledWith(sessionId))
    expect(secondWorkspace.sessionIds).toContain(sessionId)
    detach()
    await coordinator.dispose()
  })

  it('retries a transient attachment failure during the same reconciliation pass', async () => {
    const state = await fixture()
    state.attachSession.mockRejectedValueOnce(new Error('temporary workspace write failure'))
    const coordinator = new WorkspaceCoordinator(silentLogger())
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    const sessionId = SessionId('github:reviewer:owner:repo:pr:retry')
    coordinator.requestSession(sessionId, state.workspaceDir)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledTimes(2))
    expect(state.workspace.sessionIds).toContain(sessionId)
    coordinator.requestSession(sessionId, state.workspaceDir)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(state.attachSession).toHaveBeenCalledTimes(2)

    detach()
    await coordinator.dispose()
  })

  it('attaches a new reviewer session after the workspace already exists', async () => {
    const state = await fixture()
    const coordinator = new WorkspaceCoordinator(silentLogger())
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled())

    coordinator.requestSession(SessionId('github:reviewer:owner:repo:pr:2'), state.workspaceDir)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledWith('github:reviewer:owner:repo:pr:2'))
    expect(state.workspace.sessionIds).toContain('github:reviewer:owner:repo:pr:2')
    coordinator.requestSession(SessionId('github:reviewer:owner:repo:pr:2'), state.workspaceDir)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(state.attachSession).toHaveBeenCalledOnce()

    detach()
    await coordinator.dispose()
  })
})
