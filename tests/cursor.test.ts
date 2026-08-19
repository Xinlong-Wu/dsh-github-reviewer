import { describe, expect, it } from 'vitest'
import {
  CURSOR_STATUS_MISSING_INSTRUCTIONS,
  CURSOR_STATUS_REVIEWED,
  MAX_REVIEW_FAILURE_BACKOFF_MS,
  commentCheckSince,
  cursorKey,
  markCommentCheck,
  markCursor,
  markReviewFailure,
  reviewBackoffActive,
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

  it('round-trips through JSON without losing cursor fields', () => {
    const state: CursorState = {
      prs: {
        'owner/repo#2': {
          headSHA: 'sha2',
          status: CURSOR_STATUS_REVIEWED,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'owner/repo#3': {
          headSHA: 'sha3',
          lastFailedSHA: 'sha3',
          failCount: 2,
          lastFailedAt: '2026-01-01T01:00:00.000Z',
        },
      },
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })
})

describe('review failure backoff', () => {
  const base = new Date('2026-01-02T00:00:00.000Z')

  it('records consecutive failures against the same SHA and resets on a new SHA', () => {
    const state: CursorState = { prs: {} }
    markReviewFailure(state, pr(1, 'aaa'), base)
    markReviewFailure(state, pr(1, 'aaa'), new Date(base.getTime() + 1000))
    let entry = state.prs['owner/repo#1']
    expect(entry.failCount).toBe(2)
    expect(entry.lastFailedSHA).toBe('aaa')
    expect(entry.status).toBeUndefined()

    markReviewFailure(state, pr(1, 'bbb'), new Date(base.getTime() + 2000))
    entry = state.prs['owner/repo#1']
    expect(entry.failCount).toBe(1)
    expect(entry.lastFailedSHA).toBe('bbb')
  })

  it('preserves an existing terminal status when recording a failure', () => {
    const state: CursorState = { prs: {} }
    markCursor(state, pr(1, 'aaa'), CURSOR_STATUS_REVIEWED, base)
    markReviewFailure(state, pr(1, 'bbb'), base)
    const entry = state.prs['owner/repo#1']
    expect(entry.status).toBe(CURSOR_STATUS_REVIEWED)
    expect(entry.headSHA).toBe('aaa')
    expect(entry.lastFailedSHA).toBe('bbb')
  })

  it('markCursor clears failure state', () => {
    const state: CursorState = { prs: {} }
    markReviewFailure(state, pr(1, 'aaa'), base)
    markCursor(state, pr(1, 'aaa'), CURSOR_STATUS_REVIEWED, base)
    const entry = state.prs['owner/repo#1']
    expect(entry.failCount).toBeUndefined()
    expect(entry.lastFailedSHA).toBeUndefined()
    expect(entry.lastFailedAt).toBeUndefined()
  })

  it('backs off exponentially and caps the delay', () => {
    const state: CursorState = { prs: {} }
    const baseDelay = 120_000
    // One failure: delay 2 * baseDelay.
    markReviewFailure(state, pr(1, 'aaa'), base)
    const entry = state.prs['owner/repo#1']
    expect(reviewBackoffActive(entry, pr(1, 'aaa'), new Date(base.getTime() + baseDelay), baseDelay)).toBe(true)
    expect(reviewBackoffActive(entry, pr(1, 'aaa'), new Date(base.getTime() + 3 * baseDelay), baseDelay)).toBe(false)
    // A different SHA never backs off.
    expect(reviewBackoffActive(entry, pr(1, 'bbb'), base, baseDelay)).toBe(false)
  })

  it('caps the backoff delay at the maximum', () => {
    const state: CursorState = { prs: {} }
    for (let i = 0; i < 20; i++) markReviewFailure(state, pr(1, 'aaa'), base)
    const entry = state.prs['owner/repo#1']
    expect(reviewBackoffActive(entry, pr(1, 'aaa'), new Date(base.getTime() + MAX_REVIEW_FAILURE_BACKOFF_MS - 1000), 60_000)).toBe(true)
    expect(reviewBackoffActive(entry, pr(1, 'aaa'), new Date(base.getTime() + MAX_REVIEW_FAILURE_BACKOFF_MS + 1000), 60_000)).toBe(false)
  })

  it('tolerates a malformed lastFailedAt', () => {
    const state: CursorState = { prs: { 'owner/repo#1': { headSHA: 'aaa', lastFailedSHA: 'aaa', lastFailedAt: 'not a date', failCount: 3 } } }
    expect(reviewBackoffActive(state.prs['owner/repo#1'], pr(1, 'aaa'), base, 60_000)).toBe(false)
  })
})
