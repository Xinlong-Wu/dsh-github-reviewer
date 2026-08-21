// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const runtime = await import('react')
  const Icon = () => runtime.createElement('svg')
  return { IconChevronDownOutline14: Icon, IconPlusOutline16: Icon, IconTrashOutline16: Icon }
})

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore<T>(initial: T) {
    let snapshot = structuredClone(initial)
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update(recipe: (draft: T) => void) {
        const next = structuredClone(snapshot)
        recipe(next)
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  },
}))

import { apply } from '../src/client/index.ts'
import type { ReviewerSettings } from '../src/settings-contract.ts'

const value: ReviewerSettings = {
  pollIntervalMs: 120_000,
  repositories: [],
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
}

describe('github-reviewer Client apply', () => {
  it('loads and refreshes the model catalog and disposes every invalidation', async () => {
    const models = vi.fn(async () => ({
      id: 1,
      result: { ok: true as const, value: { groups: [], failures: [] } },
    }))
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const mountDispose = vi.fn()
    const remoteDisposers = [vi.fn(), vi.fn()]
    let remoteIndex = 0
    const connectionDispose = vi.fn()
    const effects: Array<() => void | Promise<void>> = []
    const register = vi.fn(() => vi.fn())
    const ctx = {
      settingsScope: {
        bind: () => ({
          getSnapshot: () => ({
            status: 'ready', value, base: value, user: {}, revision: 1, writable: true, mode: 'host',
          }),
          subscribe: () => () => {},
        }),
      },
      get: (name: string) => name === 'connection'
        ? { api: { settings: { mutate: vi.fn() }, llm: { models } } }
        : undefined,
      effect: (install: () => void | (() => void | Promise<void>)) => {
        const dispose = install()
        if (typeof dispose === 'function') effects.push(dispose)
      },
      remote: {
        $mount: vi.fn(async () => mountDispose),
        githubReviewerCatalog: {
          repositories: vi.fn(async () => ({ ok: true as const, value: { repositories: [] } })),
        },
        $on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler)
          return remoteDisposers[remoteIndex++]
        },
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return connectionDispose
      },
      locale: { register: vi.fn(() => vi.fn()) },
      slots: {
        inject: (_name: string, install: () => unknown) => { install(); return vi.fn() },
        register,
      },
    }

    await apply(ctx as never)
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(1))

    handlers.get('llm/adapters-updated')?.()
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(2))
    handlers.get('settings/document-updated')?.('llm-pi-ai', 1)
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(3))
    handlers.get('connection/reset')?.()
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(4))
    expect(register).toHaveBeenCalledTimes(1)

    for (const dispose of effects.reverse()) await dispose()
    expect(mountDispose).toHaveBeenCalledTimes(1)
    expect(remoteDisposers[0]).toHaveBeenCalledTimes(1)
    expect(remoteDisposers[1]).toHaveBeenCalledTimes(1)
    expect(connectionDispose).toHaveBeenCalledTimes(1)
    expect(document.head.querySelector('style[data-plugin="dsh-github-reviewer"]')).toBeNull()
  })
})
