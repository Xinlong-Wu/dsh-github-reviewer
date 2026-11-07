// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const runtime = await import('react')
  const Icon = () => runtime.createElement('svg')
  return { IconRefreshOutlineMedium: Icon }
})

vi.mock('dsh-github-reviewer/remote', () => ({ default: { __remoteFace: true } }))

import { apply, inject } from '../src/client/index.ts'

function clientContext() {
  const mountDispose = vi.fn()
  const effects: Array<() => void | Promise<void>> = []
  const register = vi.fn(() => vi.fn())
  const localeRegister = vi.fn(() => vi.fn())
  const repositories = vi.fn(async () => ({ ok: true as const, value: { repositories: [] } }))
  const lateInjects: string[][] = []
  const ctx = {
    effect: (install: () => void | (() => void | Promise<void>)) => {
      const dispose = install()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    // The mounted namespace exists by the time apply registers a late
    // companion, so the mock fires the callback immediately.
    inject: (namespaces: string[], callback: (bound: unknown) => void) => {
      lateInjects.push(namespaces)
      callback(ctx)
      return vi.fn()
    },
    remote: {
      $mount: vi.fn(async () => mountDispose),
      githubReviewerCatalog: { repositories },
    },
    locale: { register: localeRegister, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, install: () => unknown) => { install(); return vi.fn() },
      register,
    },
  }
  return { ctx, mountDispose, effects, register, localeRegister, repositories, lateInjects }
}

describe('github-reviewer Client apply', () => {
  it('mounts the Remote face, registers locale/styles, and contributes one Plugins-page tab', async () => {
    // The dotted namespace is a late companion (this apply mounts it), never
    // a static inject requirement: that would park the plugin PENDING forever.
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const { ctx, mountDispose, effects, register, localeRegister, lateInjects } = clientContext()

    await apply(ctx as never)

    expect(lateInjects).toEqual([['remote.githubReviewerCatalog']])
    expect(ctx.remote.$mount).toHaveBeenCalledTimes(1)
    expect(localeRegister).toHaveBeenCalledTimes(1)
    const [namespace, dictionaries] = localeRegister.mock.calls[0] as [string, Record<string, unknown>]
    expect(namespace).toBe('settings.githubReviewer')
    expect(Object.keys(dictionaries).sort()).toEqual(['en', 'zh'])
    expect(document.head.querySelector('style[data-plugin="dsh-github-reviewer"]')).not.toBeNull()
    expect(register).toHaveBeenCalledTimes(2)

    const [registration] = register.mock.calls[0] as [{
      name: string
      id: string
      label: () => string
      inject: () => { loadCatalog: unknown }
    }][]
    expect(registration.name).toBe('settings.plugins.tab')
    expect(registration.id).toBe('github-reviewer')
    expect(typeof registration.label()).toBe('string')
    expect(typeof registration.inject().loadCatalog).toBe('function')

    for (const dispose of effects.reverse()) await dispose()
    expect(mountDispose).toHaveBeenCalledTimes(1)
    expect(document.head.querySelector('style[data-plugin="dsh-github-reviewer"]')).toBeNull()
  })

  it('wires the tab loadCatalog call through the mounted Host remote', async () => {
    const { ctx, repositories } = clientContext()
    await apply(ctx as never)

    const [registration] = (ctx.slots.register as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      inject: () => { loadCatalog: (signal: AbortSignal) => Promise<unknown> }
    }][]
    const catalog = await registration.inject().loadCatalog(new AbortController().signal)
    expect(repositories).toHaveBeenCalledTimes(1)
    expect(catalog).toEqual({ repositories: [] })
  })
})
