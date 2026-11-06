// @vitest-environment jsdom

import React, { act } from 'react'
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

function props(loadCatalog: (signal: AbortSignal) => Promise<unknown>) {
  return {
    t: (key: keyof typeof en) => en[key],
    loadCatalog: loadCatalog as (signal: AbortSignal) => Promise<never>,
  }
}

async function renderTab(loadCatalog: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(GithubReviewerCatalogTab, props(loadCatalog)))
  })
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
})
