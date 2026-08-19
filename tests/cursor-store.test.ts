import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { cursorDomainSpec, StorageDomainCursorStore } from '../src/cursor-store.ts'
import type { CursorStore } from '../src/cursor-store.ts'
import {
  CURSOR_STATUS_MISSING_INSTRUCTIONS,
  CURSOR_STATUS_REVIEWED,
  emptyCursorState,
  markCursor,
} from '../src/github/cursor.ts'
import type { CursorState } from '../src/github/cursor.ts'
import type { PullRequest } from '../src/github/model.ts'

const pr: PullRequest = {
  number: 42,
  title: 't',
  body: '',
  htmlUrl: 'u',
  draft: false,
  head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo' } },
  base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo' } },
}

/** An in-memory KvTable stand-in. */
function fakeTable(): KvTable<string, CursorState> & { records: Map<string, CursorState> } {
  const records = new Map<string, CursorState>()
  return {
    records,
    get: key => records.get(key),
    put: async (key, value) => { records.set(key, value) },
    delete: async key => records.delete(key),
    update: async (key, fn) => {
      const current = records.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      records.set(key, next)
      return next
    },
    entries: () => records.entries(),
    keys: () => records.keys(),
    size: records.size,
  }
}

describe('cursorDomainSpec', () => {
  it('declares one table of per-account cursor records', () => {
    expect(cursorDomainSpec.name).toBe('dsh_github_reviewer')
    expect(cursorDomainSpec.version).toBe(0)
    expect(Object.keys(cursorDomainSpec.tables)).toEqual(['accounts'])
  })
})

describe('StorageDomainCursorStore', () => {
  it('loads an absent record as an empty cursor', async () => {
    const table = fakeTable()
    const store: CursorStore = new StorageDomainCursorStore(table, 'reviewer')
    expect(await store.load()).toEqual({ prs: {} })
    expect(table.records.size).toBe(0)
  })

  it('persists and reloads the whole cursor under the account key', async () => {
    const table = fakeTable()
    const store: CursorStore = new StorageDomainCursorStore(table, 'reviewer')
    const state = emptyCursorState()
    markCursor(state, pr, CURSOR_STATUS_REVIEWED, new Date('2026-01-01T00:00:00.000Z'))
    await store.save(state)

    expect(table.records.has('reviewer')).toBe(true)
    const reloaded: CursorStore = new StorageDomainCursorStore(table, 'reviewer')
    expect(await reloaded.load()).toEqual(state)
  })

  it('keeps accounts independent under their own keys', async () => {
    const table = fakeTable()
    const org = new StorageDomainCursorStore(table, 'org')
    const personal = new StorageDomainCursorStore(table, 'personal')
    const orgState = emptyCursorState()
    markCursor(orgState, pr, CURSOR_STATUS_REVIEWED, new Date())
    const personalState = emptyCursorState()
    markCursor(personalState, { ...pr, number: 7 }, CURSOR_STATUS_MISSING_INSTRUCTIONS, new Date())
    await org.save(orgState)
    await personal.save(personalState)

    expect((await org.load()).prs['owner/repo#42']).toBeDefined()
    expect((await personal.load()).prs['owner/repo#42']).toBeUndefined()
    expect((await personal.load()).prs['owner/repo#7']).toBeDefined()
  })
})
