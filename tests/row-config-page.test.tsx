// @vitest-environment jsdom

import React, { act } from 'react'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GithubReviewerRowConfigPage } from '../src/client/RowConfigPage.tsx'
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

const snapshot = {
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
  revision: 5,
  writable: true,
}

function formHarness(mutate: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  // ConfigPageForm.state is the plain snapshot object (slot contract).
  return {
    state: { ...snapshot, ...overrides },
    mutate,
  }
}

function props(form: Record<string, unknown> | undefined, view: 'summary' | 'page' = 'page') {
  return {
    t: (key: keyof typeof en) => en[key],
    view,
    ...(form === undefined ? {} : { form: form as never }),
  }
}

async function renderPage(form: Record<string, unknown> | undefined, view: 'summary' | 'page' = 'page'): Promise<void> {
    await act(async () => {
    root!.render(React.createElement(GithubReviewerRowConfigPage, props(form, view)))
  })
}


/** Set a controlled element's value through the native setter so React onChange fires. */
function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('GithubReviewerRowConfigPage', () => {
  it('renders the unavailable note without a form', async () => {
    await renderPage(undefined)
    expect(document.querySelector('.ghr-note')?.textContent).toBe(en.unavailable)
  })

  it('renders the summary one-liner with the monitored repository count', async () => {
    await renderPage(formHarness(vi.fn(async () => true)), 'summary')
    expect(document.body.textContent).toContain(en.repositoriesSummary.replace('%1', '1'))
  })

  it('renders the editable fields from the entry snapshot', async () => {
    await renderPage(formHarness(vi.fn(async () => true)))
    const poll = document.querySelector<HTMLInputElement>('input[type="number"]')
    expect(poll?.value).toBe('120000')
    const repositories = document.querySelector<HTMLTextAreaElement>('textarea[rows="4"]')
    expect(repositories?.value).toBe('owner/repo')
    const instructions = [...document.querySelectorAll('textarea')].at(-1)
    expect(instructions).not.toBeNull()
  })

  it('saves every volatile field through one fenced mutate', async () => {
    const mutate = vi.fn(async () => true)
    await renderPage(formHarness(mutate))

    const repositories = document.querySelector<HTMLTextAreaElement>('textarea[rows="4"]')
    await act(async () => {
      setNativeValue(repositories!, 'owner/repo\norg/other')
    })
    const save = document.querySelector<HTMLButtonElement>('.ghr-actions button')
    await act(async () => { save!.click() })

    expect(mutate).toHaveBeenCalledTimes(1)
    const ops = mutate.mock.calls[0][0] as Array<{ op: string; path: string[]; value: unknown }>
    expect(ops.map(op => op.path.join('.'))).toEqual([
      'pollIntervalMs', 'repositories', 'workspaceDir', 'workspaceTitle', 'review',
    ])
    const repositoriesOp = ops.find(op => op.path[0] === 'repositories')?.value as string[]
    expect(repositoriesOp).toEqual(['owner/repo', 'org/other'])
    expect(document.querySelector('.ghr-actions .ghr-note')?.textContent).toBe(en.savedHint)
  })

  it('reports a refused write and keeps the draft', async () => {
    const mutate = vi.fn(async () => false)
    await renderPage(formHarness(mutate))

    const repositories = document.querySelector<HTMLTextAreaElement>('textarea[rows="4"]')
    await act(async () => {
      setNativeValue(repositories!, 'owner/changed')
    })
    const save = document.querySelector<HTMLButtonElement>('.ghr-actions button')
    await act(async () => { save!.click() })

    expect(document.querySelector('.ghr-error')?.textContent).toBe(en.saveFailed)
    expect(repositories!.value).toBe('owner/changed')
  })
})
