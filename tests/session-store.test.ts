import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendSessionMessage,
  decodeSessions,
  emptySessionState,
  encodeSessions,
  JsonFileSessionStore,
} from '../src/session-store.ts'
import type { SessionState } from '../src/session-store.ts'

let dir = ''
let filePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-sessions-'))
  filePath = join(dir, 'sessions.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('appendSessionMessage', () => {
  it('appends messages under the PR key and skips blank text', () => {
    const state = emptySessionState()
    appendSessionMessage(state, 'owner/repo#1', { role: 'user', text: 'hello' }, 60)
    appendSessionMessage(state, 'owner/repo#1', { role: 'assistant', text: '   ' }, 60)
    appendSessionMessage(state, 'owner/repo#2', { role: 'user', text: 'other pr' }, 60)
    expect(state.sessions['owner/repo#1']).toEqual([{ role: 'user', text: 'hello' }])
    expect(state.sessions['owner/repo#2']).toEqual([{ role: 'user', text: 'other pr' }])
  })

  it('trims the oldest messages beyond maxMessages', () => {
    const state = emptySessionState()
    for (let index = 0; index < 5; index++) {
      appendSessionMessage(state, 'owner/repo#1', { role: 'user', text: `m${index}` }, 3)
    }
    expect(state.sessions['owner/repo#1']).toEqual([
      { role: 'user', text: 'm2' },
      { role: 'user', text: 'm3' },
      { role: 'user', text: 'm4' },
    ])
  })
})

describe('encode/decode', () => {
  it('round-trips session state', () => {
    const state: SessionState = {
      sessions: {
        'owner/repo#1': [
          { role: 'user', text: 'review request' },
          { role: 'assistant', text: 'review reply' },
        ],
      },
    }
    expect(decodeSessions(encodeSessions(state))).toEqual(state)
  })

  it('decodes an empty body as empty sessions', () => {
    expect(decodeSessions('')).toEqual({ sessions: {} })
  })

  it('drops malformed message entries', () => {
    const decoded = decodeSessions(JSON.stringify({
      sessions: {
        'owner/repo#1': [
          { role: 'user', text: 'ok' },
          { role: 'system', text: 'bad role' },
          { role: 'assistant', text: '' },
          'not-an-object',
        ],
      },
    }))
    expect(decoded.sessions['owner/repo#1']).toEqual([{ role: 'user', text: 'ok' }])
  })

  it('throws on malformed JSON', () => {
    expect(() => decodeSessions('{nope')).toThrow()
  })
})

describe('JsonFileSessionStore', () => {
  it('loads a missing file as empty and persists atomically', async () => {
    const store = new JsonFileSessionStore(filePath, 60)
    const loaded = await store.load()
    expect(loaded).toEqual({ sessions: {} })
    appendSessionMessage(loaded, 'owner/repo#9', { role: 'user', text: 'hi' }, 60)
    await store.save(loaded)
    const body = await readFile(filePath, 'utf8')
    expect(JSON.parse(body)).toEqual({ sessions: { 'owner/repo#9': [{ role: 'user', text: 'hi' }] } })
  })

  it('fails loudly on a malformed existing file', async () => {
    await writeFile(filePath, '{broken', 'utf8')
    const store = new JsonFileSessionStore(filePath, 60)
    await expect(store.load()).rejects.toThrow()
  })
})
