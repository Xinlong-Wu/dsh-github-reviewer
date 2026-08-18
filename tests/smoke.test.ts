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
    accounts: {
      reviewer: {
        appId: '123',
        installationId: '456',
        privateKeyPath: keyPath,
        baseUrl: 'https://api.github.com',
        webUrl: 'https://github.com',
        pollIntervalMs: 120000,
        repositories: ['owner/repo'],
        provider: 'deepseek',
        model: 'deepseek-chat',
        mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
        statePath: join(dir, 'cursor.json'),
        sessionPath: join(dir, 'sessions.json'),
        sessionMaxMessages: 60,
        ...overrides,
      },
    },
  }
}

const emptyStream = (): AsyncIterable<never> => ({
  async *[Symbol.asyncIterator]() {},
})

describe('plugin wiring through a real Cordis context', () => {
  it('declares its name, injects llm, and exports a Config schema', () => {
    expect(plugin.name).toBe('github-reviewer')
    expect(plugin.inject).toEqual(['llm'])
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
  })

  it('activates with a valid account and disposes cleanly', async () => {
    const keyPath = await tempKeyPath()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'tok', expires_at: '2099-01-01T00:00:00Z' }), { status: 201 })
      }
      return new Response('[]', { status: 200 })
    }))
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    const fiber = await ctx.plugin(plugin, validConfig(keyPath))
    // Let the immediate poll tick settle against the stubbed API.
    await new Promise(resolve => setTimeout(resolve, 50))
    await fiber.dispose()
    expect(fiber.state).toBe(4) // FiberState.DISPOSED (const enum, not usable as a runtime value)
  })

  it('fails activation on a missing appId', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    await expect(ctx.plugin(plugin, validConfig(keyPath, { appId: '' }))).rejects.toThrow('appId is required')
  })

  it('fails activation on an invalid repository entry', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    await expect(ctx.plugin(plugin, validConfig(keyPath, { repositories: ['not-a-repo'] }))).rejects.toThrow('owner/repo')
  })

  it('fails activation when the private key file is missing', async () => {
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    await expect(ctx.plugin(plugin, validConfig('/nonexistent/key.pem'))).rejects.toThrow('read github app private key')
  })

  it('fails activation when mcp.command is missing', async () => {
    const keyPath = await tempKeyPath()
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    await expect(ctx.plugin(plugin, validConfig(keyPath, { mcp: { command: '', args: [] } }))).rejects.toThrow('mcp.command is required')
  })

  it('activates with zero accounts as a no-op', async () => {
    const ctx = new Context()
    ctx.provide('llm', { stream: emptyStream })
    const fiber = await ctx.plugin(plugin, { accounts: {} })
    await fiber.dispose()
    expect(fiber.state).toBe(4) // FiberState.DISPOSED (const enum, not usable as a runtime value)
  })
})
