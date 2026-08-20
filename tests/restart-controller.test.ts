import { describe, expect, it, vi } from 'vitest'
import type { ResolvedAccountConfig } from '../src/config.ts'
import { ReviewerRestartController, type RestartableReviewerRuntime } from '../src/restart-controller.ts'
import { recordingLogger } from '../src/logger.ts'

function account(repository: string): ResolvedAccountConfig {
  return {
    name: 'reviewer',
    uiSettings: true,
    appId: '1',
    installationId: '2',
    privateKeyPath: '/key.pem',
    personalAccessToken: '',
    baseUrl: 'https://api.github.com',
    webUrl: 'https://github.com',
    pollIntervalMs: 120_000,
    repositories: [repository],
    workspaceDir: '/tmp/reviewer',
    workspaceTitle: 'GithubReviewer',
    review: {
      maxToolCalls: 30,
      toolTimeoutMs: 30_000,
      toolResultLimit: 60_000,
      timeoutMs: 900_000,
      defaultInstructions: '',
      commandAuthorAssociations: ['OWNER'],
      models: [],
    },
    mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
  }
}

function fakeRuntime(config: ResolvedAccountConfig, generation: number, disposed: number[]): RestartableReviewerRuntime {
  return {
    config,
    generation,
    dispose: vi.fn(async () => { disposed.push(generation) }),
  }
}

describe('ReviewerRestartController', () => {
  it('awaits initial startup and commits its config', async () => {
    const disposed: number[] = []
    const factory = vi.fn(async (config: ResolvedAccountConfig, generation: number) => fakeRuntime(config, generation, disposed))
    const controller = new ReviewerRestartController(factory, recordingLogger([]))

    await controller.start(account('owner/one'))

    expect(controller.currentConfig()?.repositories).toEqual(['owner/one'])
    expect(factory).toHaveBeenCalledTimes(1)
    await controller.dispose()
    expect(disposed).toEqual([1])
  })

  it('does not restart for a deeply equal config', async () => {
    const factory = vi.fn(async (config: ResolvedAccountConfig, generation: number) => fakeRuntime(config, generation, []))
    const controller = new ReviewerRestartController(factory, recordingLogger([]))
    const initial = account('owner/one')
    await controller.start(initial)

    controller.request(structuredClone(initial))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(factory).toHaveBeenCalledTimes(1)
    await controller.dispose()
  })

  it('replaces a runtime without overlapping generations', async () => {
    const events: string[] = []
    const factory = vi.fn(async (config: ResolvedAccountConfig, generation: number) => {
      events.push(`start:${generation}:${config.repositories[0]}`)
      return {
        config,
        generation,
        dispose: async () => { events.push(`stop:${generation}`) },
      }
    })
    const controller = new ReviewerRestartController(factory, recordingLogger([]))
    await controller.start(account('owner/one'))

    controller.request(account('owner/two'))
    await vi.waitFor(() => expect(controller.currentConfig()?.repositories).toEqual(['owner/two']))

    expect(events).toEqual(['start:1:owner/one', 'stop:1', 'start:2:owner/two'])
    await controller.dispose()
  })

  it('rolls back operationally when candidate startup fails', async () => {
    const lines: string[] = []
    let attempts = 0
    const factory = vi.fn(async (config: ResolvedAccountConfig, generation: number) => {
      attempts += 1
      if (config.repositories[0] === 'owner/bad') throw new Error('candidate failed')
      return fakeRuntime(config, generation, [])
    })
    const controller = new ReviewerRestartController(factory, recordingLogger(lines))
    await controller.start(account('owner/good'))

    controller.request(account('owner/bad'))
    await vi.waitFor(() => expect(attempts).toBe(3))

    expect(controller.currentConfig()?.repositories).toEqual(['owner/good'])
    expect(lines.some(line => line.includes('restart failed'))).toBe(true)
    expect(lines.some(line => line.includes('restored the previous'))).toBe(true)
    await controller.dispose()
  })

  it('keeps the controller recoverable after candidate and rollback both fail', async () => {
    let failOld = false
    const factory = vi.fn(async (config: ResolvedAccountConfig, generation: number) => {
      const repo = config.repositories[0]
      if (repo === 'owner/bad' || (repo === 'owner/old' && failOld)) throw new Error(`failed ${repo}`)
      return fakeRuntime(config, generation, [])
    })
    const controller = new ReviewerRestartController(factory, recordingLogger([]))
    await controller.start(account('owner/old'))
    failOld = true

    controller.request(account('owner/bad'))
    await vi.waitFor(() => expect(controller.currentConfig()).toBeUndefined())
    failOld = false
    controller.request(account('owner/recovered'))
    await vi.waitFor(() => expect(controller.currentConfig()?.repositories).toEqual(['owner/recovered']))

    await controller.dispose()
  })
})
