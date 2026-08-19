import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { Config } from '../src/config.ts'

let dir = ''

afterEach(async () => {
  vi.unstubAllGlobals()
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

async function tempKeyPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-smoke-'))
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pemPath = join(dir, 'app.pem')
  await writeFile(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return pemPath
}

function validConfig(keyPath: string, overrides: Record<string, unknown> = {}): Config {
  return {
    name: 'reviewer',
    appId: '123',
    installationId: '456',
    privateKeyPath: keyPath,
    baseUrl: 'https://api.github.com',
    webUrl: 'https://github.com',
    pollIntervalMs: 120000,
    repositories: ['owner/repo'],
    mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
    ...overrides,
  }
}

/** Minimal agent registry and session store stand-ins for activation tests. */
function provideCoreServices(ctx: Context): void {
  ctx.provide('agents', {
    create: vi.fn(),
    resume: vi.fn(),
  })
  ctx.provide('sessions', {
    flush: vi.fn(async () => true),
  })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  })
  const records = new Map<string, unknown>()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => ({
        get: (key: string) => records.get(key),
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async () => true,
        update: async () => undefined,
        entries: () => records.entries(),
        keys: () => records.keys(),
        size: records.size,
      }),
      close: async () => {},
    }),
  })
}

describe('plugin wiring through a real Cordis context', () => {
  it('declares its name, injects agents/sessions/agentDefaultModel/storageDomain, and exports a Config schema', () => {
    expect(plugin.name).toBe('github-reviewer')
    expect(plugin.inject).toEqual(['agents', 'sessions', 'agentDefaultModel', 'storageDomain'])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
  })

  it('activates with a valid account and disposes cleanly', async () => {
    const keyPath = await tempKeyPath()
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'tok', expires_at: '2099-01-01T00:00:00Z' }), { status: 201 })
      }
      return new Response('[]', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    provideCoreServices(ctx)
    const fiber = await ctx.plugin(plugin, validConfig(keyPath))
    // Let the immediate poll tick settle against the stubbed API.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/pulls'))).toBe(true)
    })
    await fiber.dispose()
    expect(fiber.state).toBe(4) // FiberState.DISPOSED (const enum, not usable as a runtime value)
  })

  it('fails activation on a missing appId', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig(keyPath, { appId: '' }))).rejects.toThrow('appId is required')
  })

  it('fails activation on an invalid repository entry', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig(keyPath, { repositories: ['not-a-repo'] }))).rejects.toThrow('owner/repo')
  })

  it('fails activation when the private key file is missing', async () => {
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig('/nonexistent/key.pem'))).rejects.toThrow('read github app private key')
  })

  it('fails activation when mcp.command is missing', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig(keyPath, { mcp: { command: '', args: [] } }))).rejects.toThrow('mcp.command is required')
  })

  it('fails activation on an empty config', async () => {
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, {} as Config)).rejects.toThrow('appId is required')
  })

  it('fails activation on an empty or non-http baseUrl', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig(keyPath, { baseUrl: '' }))).rejects.toThrow('baseUrl is required')
    const ctx2 = new Context()
    provideCoreServices(ctx2)
    await expect(ctx2.plugin(plugin, validConfig(keyPath, { baseUrl: 'ftp://example.com' }))).rejects.toThrow('baseUrl must be http(s)')
  })

  it('fails activation when the same account name is already active', async () => {
    const keyPath = await tempKeyPath()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const ctx = new Context()
    provideCoreServices(ctx)
    const fiber = await ctx.plugin(plugin, validConfig(keyPath))
    await vi.waitFor(() => expect(fiber.state).toBe(2)) // FiberState.ACTIVE
    await expect(ctx.plugin(plugin, validConfig(keyPath))).rejects.toThrow('already active')
    await fiber.dispose()
  })

  it('activates with a personal access token and never exchanges an App JWT', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    provideCoreServices(ctx)
    const fiber = await ctx.plugin(plugin, validConfig('', {
      appId: '',
      installationId: '',
      privateKeyPath: '',
      personalAccessToken: 'github_pat_xxx',
    }))
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/pulls'))).toBe(true)
    })
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/access_tokens'))).toBe(false)
    await fiber.dispose()
    expect(fiber.state).toBe(4) // FiberState.DISPOSED (const enum, not usable as a runtime value)
  })

  it('registers the review workspace when the workspace service is mounted', async () => {
    const keyPath = await tempKeyPath()
    const create = vi.fn(async () => ({}))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const ctx = new Context()
    provideCoreServices(ctx)
    ctx.provide('workspace', { create })
    const fiber = await ctx.plugin(plugin, validConfig(keyPath, { workspaceDir: join(dir, 'ws') }))
    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith(join(dir, 'ws'), 'GithubReviewer')
    await fiber.dispose()
    expect(fiber.state).toBe(4)
  })

  it('still activates when workspace registration fails', async () => {
    const keyPath = await tempKeyPath()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const ctx = new Context()
    provideCoreServices(ctx)
    ctx.provide('workspace', {
      create: vi.fn(async () => { throw new Error('workspace backend unavailable') }),
    })
    const fiber = await ctx.plugin(plugin, validConfig(keyPath, { workspaceDir: join(dir, 'ws') }))
    await vi.waitFor(() => expect(fiber.state).toBe(2)) // FiberState.ACTIVE
    await fiber.dispose()
    expect(fiber.state).toBe(4)
  })

  it('fails activation when a personal access token is mixed with App credentials', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    provideCoreServices(ctx)
    await expect(ctx.plugin(plugin, validConfig(keyPath, { personalAccessToken: 'ghp_xxx' }))).rejects.toThrow('mutually exclusive')
  })

  it('stays pending when the storage-domain service is not mounted', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    ctx.provide('agents', { create: vi.fn(), resume: vi.fn() })
    ctx.provide('sessions', { flush: vi.fn(async () => true) })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) })
    const fiber = ctx.plugin(plugin, validConfig(keyPath))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fiber.state).toBe(0) // FiberState.PENDING (const enum, not usable as a runtime value)
    await fiber.dispose()
  })
})
