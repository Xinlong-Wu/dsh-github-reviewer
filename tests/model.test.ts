import { describe, expect, it } from 'vitest'
import { fullName, parseRepository, sameRepo, shortSHA, truncateForError } from '../src/github/model.ts'

describe('parseRepository', () => {
  it('parses owner/repo', () => {
    expect(parseRepository('owner/repo')).toEqual({ owner: 'owner', name: 'repo' })
    expect(parseRepository('  owner / repo  ')).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('rejects malformed values', () => {
    expect(parseRepository('')).toBeUndefined()
    expect(parseRepository('owner')).toBeUndefined()
    expect(parseRepository('owner/')).toBeUndefined()
    expect(parseRepository('/repo')).toBeUndefined()
    expect(parseRepository('a/b/c')).toBeUndefined()
  })
})

describe('repository helpers', () => {
  it('compares repositories case-insensitively', () => {
    expect(sameRepo({ owner: 'Owner', name: 'Repo' }, { owner: 'owner', name: 'repo' })).toBe(true)
    expect(sameRepo({ owner: 'a', name: 'b' }, { owner: 'a', name: 'c' })).toBe(false)
  })

  it('formats full names', () => {
    expect(fullName({ owner: 'o', name: 'r' })).toBe('o/r')
    expect(fullName({ owner: '', name: 'r' })).toBe('')
  })
})

describe('shortSHA', () => {
  it('truncates long SHAs to 12 characters', () => {
    expect(shortSHA('0123456789abcdef')).toBe('0123456789ab')
  })

  it('keeps short values', () => {
    expect(shortSHA('abc')).toBe('abc')
    expect(shortSHA('  abc  ')).toBe('abc')
  })
})

describe('truncateForError', () => {
  it('truncates long bodies', () => {
    const long = 'x'.repeat(600)
    expect(truncateForError(long)).toBe(`${'x'.repeat(512)}...[truncated]`)
  })

  it('keeps short bodies', () => {
    expect(truncateForError('short')).toBe('short')
  })
})
