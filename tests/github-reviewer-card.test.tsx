// @vitest-environment jsdom

import React, { act } from 'react'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const runtime = await import('react')
  const Icon = () => runtime.createElement('svg')
  return { IconRefreshOutlineMedium: Icon }
})

import { GithubReviewerCatalogTab } from '../src/client/GithubReviewerCard.tsx'
import { en } from '../src/client/locales.ts'

let container: HTMLElement | undefined
let root: Root | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  vi.restoreAllMocks()
})

function props(loadCatalog: (signal: AbortSignal) => Promise<unknown>, form?: Record<string, unknown>) {
  return {
    t: (key: keyof typeof en) => en[key],
    loadCatalog: loadCatalog as (signal: AbortSignal) => Promise<never>,
    ...(form === undefined ? {} : { configForm: form as never }),
  }
}

async function renderTab(loadCatalog: (signal: AbortSignal) => Promise<unknown>, form?: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(GithubReviewerCatalogTab, props(loadCatalog, form)))
  })
}

const formSnapshot = {
  status: 'ready' as const,
  value: {
    pollIntervalMs: 120_000,
    repositories: ['owner/repo'],
    workspaceDir: '/tmp/reviewer',
    workspaceTitle: 'GithubReviewer',
    review: {
      maxToolCalls: 30,
      toolTimeoutMs: 30_000,
      toolResultLimit: 60_000,
      timeoutMs: 900_000,
      defaultInstructions: '',
      commandAuthorAssociations: ['OWNER'],
    },
  },
  base: undefined,
  user: undefined,
  revision: 3,
  writable: true,
}

function formHarness(mutate: ReturnType<typeof vi.fn>) {
  return {
    getSnapshot: () => formSnapshot,
    subscribe: vi.fn(() => vi.fn()),
    mutate,
  }
}

describe('GithubReviewerCatalogTab', () => {
  it('loads the catalog on mount and renders one row per accessible repository', async () => {
    const loadCatalog = vi.fn(async () => ({
      repositories: [
        { owner: 'owner', repository: 'repo', fullName: 'owner/repo', private: false },
        { owner: 'org', repository: 'secret', fullName: 'org/secret', private: true },
      ],
    }))
    await renderTab(loadCatalog)

    const rows = [...document.querySelectorAll('.ghr-repo-name')].map(node => node.textContent)
    expect(rows).toEqual(['owner/repo', 'org/secret'])
    expect(document.querySelector('.ghr-badge')?.textContent).toBe(en.privateRepository)
    expect(document.querySelector('.ghr-note')).toBeNull()
  })

  it('shows the empty message when no repository is monitored', async () => {
    await renderTab(vi.fn(async () => ({ repositories: [] })))
    expect(document.querySelector('.ghr-note')?.textContent).toBe(en.repositoriesEmpty)
  })

  it('reports a failed Host catalog call and reloads from the refresh control', async () => {
    const loadCatalog = vi.fn()
      .mockRejectedValueOnce(new Error('host down'))
      .mockResolvedValueOnce({ repositories: [{ owner: 'o', repository: 'r', fullName: 'o/r', private: false }] })
    await renderTab(loadCatalog)

    expect(document.querySelector('.ghr-error')?.textContent).toContain(en.repositoryCatalogLoadFailed)

    const refresh = document.querySelector<HTMLButtonElement>('.ghr-refresh')
    expect(refresh).not.toBeNull()
    await act(async () => { refresh!.click() })

    expect(loadCatalog).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.ghr-repo-name')?.textContent).toBe('o/r')
    expect(document.querySelector('.ghr-error')).toBeNull()
  })

  it('renders the config form fields from the entry snapshot', async () => {
    await renderTab(vi.fn(async () => ({ repositories: [] })), formHarness(vi.fn(async () => true)))

    expect(document.querySelector('.ghr-config')).not.toBeNull()
    const poll = document.querySelector<HTMLInputElement>('input[type="number"]')
    expect(poll?.value).toBe('120000')
    const repositories = document.querySelector<HTMLTextAreaElement>('textarea[rows="4"]')
    expect(repositories?.value).toBe('owner/repo')
  })

  it('saves the volatile fields through one fenced mutate', async () => {
    const mutate = vi.fn(async () => true)
    await renderTab(vi.fn(async () => ({ repositories: [] })), formHarness(mutate))

    const save = document.querySelector<HTMLButtonElement>('.ghr-actions .ghr-refresh')
    expect(save?.textContent).toBe(en.saving === undefined ? undefined : en.save)
    await act(async () => { save!.click() })

    expect(mutate).toHaveBeenCalledTimes(1)
    const ops = mutate.mock.calls[0][0] as Array<{ op: string; path: string[]; value: unknown }>
    expect(ops.map(op => op.path.join('.'))).toEqual([
      'pollIntervalMs', 'repositories', 'workspaceDir', 'workspaceTitle', 'review',
    ])
    const review = ops.find(op => op.path[0] === 'review')?.value as { maxToolCalls: number }
    expect(review.maxToolCalls).toBe(30)
    expect(document.querySelector(".ghr-actions .ghr-note")?.textContent).toBe(en.savedHint)
  })

  it('reports a refused write and keeps the draft', async () => {
    await renderTab(vi.fn(async () => ({ repositories: [] })), formHarness(vi.fn(async () => false)))

    const save = document.querySelector<HTMLButtonElement>('.ghr-actions .ghr-refresh')
    await act(async () => { save!.click() })

    expect(document.querySelector('.ghr-error')?.textContent).toBe(en.saveFailed)
  })

  it('shows the unavailable note when the composition lacks the form', async () => {
    const loadCatalog = vi.fn(async () => ({ repositories: [] }))
    await renderTab(loadCatalog, undefined)
    expect(document.querySelector('.ghr-config')).toBeNull()
    expect(document.querySelector('.ghr-note')?.textContent).toBe(en.repositoriesEmpty)
  })
})
