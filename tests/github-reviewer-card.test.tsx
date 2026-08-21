// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const runtime = await import('react')
  const Icon = () => runtime.createElement('svg')
  return { IconChevronDownOutline14: Icon, IconPlusOutline16: Icon, IconTrashOutline16: Icon }
})

import { GithubReviewerCard } from '../src/client/GithubReviewerCard.tsx'
import type { GithubReviewerCardState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

function state(overrides: Partial<GithubReviewerCardState> = {}): GithubReviewerCardState {
  return {
    available: true,
    writable: true,
    saving: false,
    dirty: false,
    failed: false,
    fields: {
      pollIntervalMs: { text: '120000', overridden: false, invalid: false },
      workspaceDir: { text: '/tmp/reviewer', overridden: false, invalid: false },
      workspaceTitle: { text: 'GithubReviewer', overridden: false, invalid: false },
      maxToolCalls: { text: '30', overridden: false, invalid: false },
      toolTimeoutMs: { text: '30000', overridden: false, invalid: false },
      toolResultLimit: { text: '60000', overridden: false, invalid: false },
      timeoutMs: { text: '900000', overridden: false, invalid: false },
      defaultInstructions: { text: '', overridden: false, invalid: false },
      commandAuthorAssociations: { text: 'OWNER', overridden: false, invalid: false },
    },
    repositories: {
      rows: [{ owner: 'owner', repository: 'repo' }],
      overridden: false,
      invalid: false,
    },
    repositoryCatalog: {
      loading: false,
      loaded: true,
      error: null,
      repositories: [{ owner: 'owner', repository: 'repo', fullName: 'owner/repo', private: false }],
    },
    models: {
      rows: [{ provider: 'openai', model: 'gpt' }],
      overridden: false,
      invalid: false,
    },
    modelCatalog: {
      loading: false,
      error: null,
      failures: [],
      groups: [
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
        { id: 'empty', name: 'Empty provider', models: [] },
      ],
    },
    ...overrides,
  }
}

function props(snapshot: GithubReviewerCardState) {
  return {
    useGithubReviewerCard: (selector: (value: GithubReviewerCardState) => unknown) => selector(snapshot),
    t: (key: keyof typeof en) => en[key],
    edit: vi.fn(),
    reset: vi.fn(),
    addRepository: vi.fn(),
    editRepository: vi.fn(),
    ensureRepositoryCatalog: vi.fn(),
    retryRepositoryCatalog: vi.fn(),
    removeRepository: vi.fn(),
    addModel: vi.fn(),
    editModelProvider: vi.fn(),
    editModel: vi.fn(),
    removeModel: vi.fn(),
    moveModel: vi.fn(),
    retryModels: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(snapshot: GithubReviewerCardState) {
  const injected = props(snapshot)
  act(() => { root.render(<GithubReviewerCard {...injected as never} />) })
  return injected
}

function expand(): void {
  const header = container.querySelector<HTMLButtonElement>('.ghr-header')
  if (header === null) throw new Error('missing card header')
  act(() => { header.click() })
}

describe('GithubReviewerCard', () => {
  it('uses the exact title and starts collapsed like other plugin cards', () => {
    render(state())

    const header = container.querySelector<HTMLButtonElement>('.ghr-header')
    expect(header?.textContent).toContain('GitHub Reviewer')
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.ghr-body')).toBeNull()

    expand()
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.ghr-body')).not.toBeNull()
  })

  it('keeps the unsaved marker visible while collapsed', () => {
    render(state({ dirty: true }))
    expect(container.textContent).toContain('Unsaved')
    expect(container.querySelector('.ghr-body')).toBeNull()
  })

  it('renders repository rows instead of a multiline repository textarea', () => {
    const injected = render(state())
    expand()

    expect(container.querySelectorAll('.ghr-collection textarea')).toHaveLength(0)
    const repositoryInputs = container.querySelectorAll<HTMLInputElement>('.ghr-collection:first-of-type input')
    expect([...repositoryInputs].map(input => input.value)).toEqual(['owner', 'repo'])
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add repository"]')
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove: owner/repo, Position 1"]')
    expect(add?.textContent).toBe('')
    expect(add?.querySelector('svg')).not.toBeNull()
    expect(remove?.textContent).toBe('')
    expect(remove?.querySelector('svg')).not.toBeNull()
    act(() => { add?.click() })
    expect(injected.addRepository).toHaveBeenCalledTimes(1)
  })

  it('filters editable repository suggestions by owner and lazy-loads on focus', () => {
    const injected = render(state({
      repositories: { rows: [{ owner: 'alpha', repository: '' }], overridden: true, invalid: true },
      repositoryCatalog: {
        loading: false,
        loaded: true,
        error: null,
        repositories: [
          { owner: 'alpha', repository: 'one', fullName: 'alpha/one', private: false },
          { owner: 'alpha', repository: 'two', fullName: 'alpha/two', private: true },
          { owner: 'beta', repository: 'other', fullName: 'beta/other', private: false },
        ],
      },
    }))
    expand()

    const inputs = container.querySelectorAll<HTMLInputElement>('[role="combobox"]')
    act(() => { inputs[1]?.focus() })
    expect(injected.ensureRepositoryCatalog).toHaveBeenCalledTimes(1)
    const visibleOptions = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .filter(option => !option.closest('[hidden]'))
    expect(visibleOptions.map(option => option.textContent)).toEqual(['one', 'two'])
    expect(visibleOptions.every(option => option.tabIndex === -1)).toBe(true)

    act(() => {
      inputs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(injected.editRepository).not.toHaveBeenCalled()
    act(() => {
      inputs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      inputs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(injected.editRepository).toHaveBeenCalledWith(0, 'repository', 'one')
  })

  it('warns for catalog misses without disabling manual save', () => {
    render(state({
      dirty: true,
      repositories: { rows: [{ owner: 'manual', repository: 'repo' }], overridden: true, invalid: false },
    }))
    expand()

    expect(container.textContent).toContain(en.repositoryCatalogUnknown)
    expect(container.querySelector<HTMLButtonElement>('.ghr-primary')?.disabled).toBe(false)
  })

  it('renders provider and model selects from the Host model catalog', () => {
    const injected = render(state())
    expand()

    const selects = container.querySelectorAll<HTMLSelectElement>('.ghr-collection:nth-of-type(2) select')
    expect(selects).toHaveLength(2)
    expect([...selects[0].options].map(option => option.textContent)).toEqual(['OpenAI', 'DeepSeek'])
    expect([...selects[1].options].map(option => option.textContent)).toEqual(['GPT'])
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add model"]')
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove: openai/gpt, Position 1"]')
    expect(add?.textContent).toBe('')
    expect(add?.querySelector('svg')).not.toBeNull()
    expect(remove?.textContent).toBe('')
    expect(remove?.querySelector('svg')).not.toBeNull()

    act(() => {
      selects[0].value = 'deepseek'
      selects[0].dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(injected.editModelProvider).toHaveBeenCalledWith(0, 'deepseek')
  })

  it('moves model priority by drag and keyboard', () => {
    const injected = render(state({
      models: {
        rows: [{ provider: 'openai', model: 'gpt' }, { provider: 'deepseek', model: 'chat' }],
        overridden: true,
        invalid: false,
      },
    }))
    expand()

    const handles = container.querySelectorAll<HTMLButtonElement>('.ghr-drag-handle')
    const rows = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData(type: string, payload: string) { data.set(type, payload) },
      getData(type: string) { return data.get(type) ?? '' },
      setDragImage: vi.fn(),
    }
    const dragStart = new Event('dragstart', { bubbles: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    const dragOver = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(dragOver, 'dataTransfer', { value: dataTransfer })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })

    act(() => {
      handles[0].dispatchEvent(dragStart)
      rows[1].dispatchEvent(dragOver)
      rows[1].dispatchEvent(drop)
    })
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(rows[0], 0, 0)
    expect(injected.moveModel).toHaveBeenCalledWith(0, 1)

    const refreshedHandles = container.querySelectorAll<HTMLButtonElement>('.ghr-drag-handle')
    act(() => { refreshedHandles[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(injected.moveModel).toHaveBeenCalledWith(1, 0)
  })

  it('clears a target shadow as soon as the pointer leaves the block', () => {
    render(state({
      models: {
        rows: [{ provider: 'openai', model: 'gpt' }, { provider: 'deepseek', model: 'chat' }],
        overridden: true,
        invalid: false,
      },
    }))
    expand()

    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData(type: string, payload: string) { data.set(type, payload) },
      getData(type: string) { return data.get(type) ?? '' },
      setDragImage: vi.fn(),
    }
    const event = (type: string) => {
      const value = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(value, 'dataTransfer', { value: dataTransfer })
      return value
    }
    const handles = container.querySelectorAll<HTMLButtonElement>('.ghr-drag-handle')
    act(() => { handles[0].dispatchEvent(event('dragstart')) })

    let target = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')[1]
    act(() => {
      target.dispatchEvent(event('dragenter'))
      target.dispatchEvent(event('dragenter'))
    })
    target = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')[1]
    expect(target.classList.contains('ghr-model-row-target')).toBe(true)

    act(() => { target.dispatchEvent(event('dragleave')) })
    target = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')[1]
    expect(target.classList.contains('ghr-model-row-target')).toBe(true)

    act(() => { target.dispatchEvent(event('dragleave')) })
    target = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')[1]
    expect(target.classList.contains('ghr-model-row-target')).toBe(false)
  })

  it('keeps keyboard focus on the candidate after it moves', () => {
    let snapshot = state({
      models: {
        rows: [{ provider: 'openai', model: 'gpt' }, { provider: 'deepseek', model: 'chat' }],
        overridden: true,
        invalid: false,
      },
    })
    const injected = props(snapshot)
    injected.useGithubReviewerCard = selector => selector(snapshot)
    injected.moveModel.mockImplementation((fromIndex: number, toIndex: number) => {
      const rows = snapshot.models.rows.map(row => ({ ...row }))
      const [row] = rows.splice(fromIndex, 1)
      if (row !== undefined) rows.splice(toIndex, 0, row)
      snapshot = { ...snapshot, models: { ...snapshot.models, rows } }
      root.render(<GithubReviewerCard {...injected as never} />)
    })
    act(() => { root.render(<GithubReviewerCard {...injected as never} />) })
    expand()

    const first = container.querySelectorAll<HTMLButtonElement>('.ghr-drag-handle')[0]
    act(() => {
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(snapshot.models.rows[1]).toEqual({ provider: 'openai', model: 'gpt' })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move model candidate: openai/gpt, Position 2')
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Position: 2')
  })

  it('disables icon actions and rejects drops in read-only mode', () => {
    const injected = render(state({
      writable: false,
      models: {
        rows: [{ provider: 'openai', model: 'gpt' }, { provider: 'deepseek', model: 'chat' }],
        overridden: true,
        invalid: false,
      },
    }))
    expand()

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Add repository"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Add model"]')?.disabled).toBe(true)
    const handle = container.querySelector<HTMLButtonElement>('.ghr-drag-handle')
    expect(handle?.disabled).toBe(true)
    expect(handle?.getAttribute('draggable')).toBe('false')

    const dataTransfer = { getData: () => '0' }
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    const rows = container.querySelectorAll<HTMLDivElement>('.ghr-model-row')
    act(() => { rows[1].dispatchEvent(drop) })
    expect(injected.moveModel).not.toHaveBeenCalled()
  })

  it('shows valid empty repository and model states', () => {
    render(state({
      repositories: { rows: [], overridden: true, invalid: false },
      models: { rows: [], overridden: true, invalid: false },
    }))
    expand()

    expect(container.textContent).toContain('No repositories are monitored.')
    expect(container.textContent).toContain('No explicit model candidates.')
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save and restart reviewer')
    expect(save?.disabled).toBe(true)
  })
})
