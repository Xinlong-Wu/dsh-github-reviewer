import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURSOR_STATUS_REVIEWED, emptyCursorState, markCursor } from '../src/github/cursor.ts'
import { JsonFileCursorStore } from '../src/state-file.ts'

let dir = ''
let filePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-state-'))
  filePath = join(dir, 'cursor.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('JsonFileCursorStore', () => {
  it('loads a missing file as empty', async () => {
    const store = new JsonFileCursorStore(filePath)
    expect(await store.load()).toEqual({ prs: {} })
  })

  it('rejects a malformed existing file', async () => {
    await writeFile(filePath, '{broken', 'utf8')
    const store = new JsonFileCursorStore(filePath)
    await expect(store.load()).rejects.toThrow()
  })

  it('rethrows non-ENOENT read failures', async () => {
    const store = new JsonFileCursorStore(dir) // a directory cannot be read as a file
    await expect(store.load()).rejects.toThrow()
  })

  it('persists state atomically and serves the saved snapshot', async () => {
    const store = new JsonFileCursorStore(filePath)
    const state = emptyCursorState()
    markCursor(state, {
      number: 7,
      head: { sha: 'head-sha' },
      base: { repo: { owner: 'owner', name: 'repo' } },
    } as never, CURSOR_STATUS_REVIEWED, new Date('2026-01-01T00:00:00.000Z'))
    await store.save(state)

    const body = JSON.parse(await readFile(filePath, 'utf8')) as { prs: Record<string, unknown> }
    expect(body.prs['owner/repo#7']).toBeDefined()

    const reloaded = new JsonFileCursorStore(filePath)
    expect(await reloaded.load()).toEqual(state)
  })

  it('cleans up the temp file when the rename fails', async () => {
    // A directory sitting at the target path makes the rename fail.
    await mkdir(filePath)
    const store = new JsonFileCursorStore(filePath)
    await expect(store.save(emptyCursorState())).rejects.toThrow()
    const leftovers = (await readdir(dir)).filter(name => name.endsWith('.tmp'))
    expect(leftovers).toHaveLength(0)
  })

  it('builds the default account path', () => {
    expect(JsonFileCursorStore.defaultPath('reviewer')).toBe(join('.dsh-github-reviewer', 'reviewer.json'))
  })
})
