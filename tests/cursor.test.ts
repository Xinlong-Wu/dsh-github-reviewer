import { describe, expect, it } from 'vitest'
import {
  CURSOR_STATUS_MISSING_INSTRUCTIONS,
  CURSOR_STATUS_REVIEWED,
  commentCheckSince,
  cursorKey,
  decodeCursor,
  encodeCursor,
  markCommentCheck,
  markCursor,
  shouldProcessCursor,
} from '../src/github/cursor.ts'
import type { CursorState } from '../src/github/cursor.ts'
import type { PullRequest } from '../src/github/model.ts'

function pr(number: number, headSha: string, repo = 'owner/repo'): PullRequest {
  const [owner, name] = repo.split('/')
  return {
    number,
    title: 'title',
    body: '',
    htmlUrl: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    head: { sha: headSha, ref: 'feature', repo: { owner, name } },
    base: { sha: 'base-sha', ref: 'main', repo: { owner, name } },
  }
}

describe('cursor state', () => {
  it('reviews unseen PRs', () => {
    expect(shouldProcessCursor({ prs: {} }, pr(1, 'aaa'))).toBe(true)
  })

  it('reviews PRs whose head SHA changed', () => {
    const state: CursorState = { prs: { 'owner/repo#1': { headSHA: 'old', status: CURSOR_STATUS_REVIEWED } } }
    expect(shouldProcessCursor(state, pr(1, 'new'))).toBe(true)
  })

  it('skips reviewed PRs with an unchanged head SHA', () => {
    const state: CursorState = { prs: { 'owner/repo#1': { headSHA: 'aaa', status: CURSOR_STATUS_REVIEWED } } }
    expect(shouldProcessCursor(state, pr(1, 'aaa'))).toBe(false)
  })

  it('skips missing-instructions PRs with an unchanged head SHA', () => {
    const state: CursorState = { prs: { 'owner/repo#1': { headSHA: 'aaa', status: CURSOR_STATUS_MISSING_INSTRUCTIONS } } }
    expect(shouldProcessCursor(state, pr(1, 'aaa'))).toBe(false)
  })

  it('marks and re-checks cursors', () => {
    const state: CursorState = { prs: {} }
    const now = new Date('2026-01-02T03:04:05.000Z')
    markCursor(state, pr(7, 'head7'), CURSOR_STATUS_REVIEWED, now)
    expect(state.prs[cursorKey(pr(7, 'head7'))]).toEqual({
      headSHA: 'head7',
      status: 'reviewed',
      updatedAt: '2026-01-02T03:04:05.000Z',
      lastCommentCheck: '2026-01-02T03:04:05.000Z',
    })
    const later = new Date('2026-01-02T04:00:00.000Z')
    markCommentCheck(state, pr(7, 'head7'), later)
    expect(commentCheckSince(state.prs[cursorKey(pr(7, 'head7'))])?.toISOString()).toBe('2026-01-02T04:00:00.000Z')
  })

  it('falls back to updatedAt when the comment check is missing', () => {
    const entry: CursorState['prs'][string] = {
      headSHA: 'a',
      status: CURSOR_STATUS_REVIEWED,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    expect(commentCheckSince(entry)?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  it('round-trips encoding', () => {
    const state: CursorState = {
      prs: {
        'owner/repo#2': {
          headSHA: 'sha2',
          status: CURSOR_STATUS_REVIEWED,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    expect(decodeCursor(encodeCursor(state))).toEqual(state)
  })

  it('decodes an empty body as an empty cursor', () => {
    expect(decodeCursor('')).toEqual({ prs: {} })
  })

  it('throws on malformed JSON', () => {
    expect(() => decodeCursor('{not json')).toThrow()
  })
})
