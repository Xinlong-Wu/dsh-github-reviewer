import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
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
    get sessionIds() { return attachedSessionIds },
    attachSession,
  } as unknown as Workspace
  const create = vi.fn(async () => workspace)
  const registry = { create } as unknown as WorkspaceRegistry
  const config = { workspaceDir, workspaceTitle: 'GithubReviewer' } as ResolvedAccountConfig
  return { workspaceDir, workspace, attachSession, create, registry, config }
}

describe('WorkspaceCoordinator session accounting', () => {
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

  it('retries a failed attachment when the live reviewer session is announced again', async () => {
    const state = await fixture()
    state.attachSession.mockRejectedValueOnce(new Error('temporary workspace write failure'))
    const coordinator = new WorkspaceCoordinator(silentLogger())
    const detach = coordinator.attach(state.registry)
    coordinator.request(state.config)
    coordinator.requestSession(SessionId('github:reviewer:owner:repo:pr:retry'), state.workspaceDir)
    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledOnce())

    coordinator.requestSession(SessionId('github:reviewer:owner:repo:pr:retry'), state.workspaceDir)

    await vi.waitFor(() => expect(state.attachSession).toHaveBeenCalledTimes(2))
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
