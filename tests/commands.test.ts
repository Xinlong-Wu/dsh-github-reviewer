import { describe, expect, it } from 'vitest'
import { parseCommentCommand } from '../src/github/commands.ts'

describe('parseCommentCommand', () => {
  it('returns none for empty or commandless comments', () => {
    expect(parseCommentCommand('')).toEqual({ type: 'none', message: '' })
    expect(parseCommentCommand('  \n \n')).toEqual({ type: 'none', message: '' })
    expect(parseCommentCommand('Nice work!')).toEqual({ type: 'none', message: '' })
  })

  it('parses a bare /review command', () => {
    expect(parseCommentCommand('/review')).toEqual({ type: 'review', message: '' })
    expect(parseCommentCommand('  /REVIEW  ')).toEqual({ type: 'review', message: '' })
  })

  it('parses /review with trailing text and ignores later lines', () => {
    expect(parseCommentCommand('/review please\n\nmore text')).toEqual({ type: 'review', message: '' })
  })

  it('parses a single-line /bot message', () => {
    expect(parseCommentCommand('/bot explain this diff')).toEqual({ type: 'bot', message: 'explain this diff' })
  })

  it('keeps the full body for a multi-line /bot message', () => {
    const body = '/bot explain this diff\nmore context here'
    expect(parseCommentCommand(body)).toEqual({ type: 'bot', message: 'explain this diff\nmore context here' })
  })

  it('rejects /bot without a message', () => {
    expect(parseCommentCommand('/bot')).toEqual({ type: 'none', message: '' })
    expect(parseCommentCommand('/bot   ')).toEqual({ type: 'none', message: '' })
  })

  it('does not treat a command in a later line as a command', () => {
    expect(parseCommentCommand('thanks\n/bot hi')).toEqual({ type: 'none', message: '' })
  })

  it('recognizes commands separated by tabs or other whitespace', () => {
    expect(parseCommentCommand('/review\tnow')).toEqual({ type: 'review', message: '' })
    expect(parseCommentCommand('/bot\thello')).toEqual({ type: 'bot', message: 'hello' })
    expect(parseCommentCommand('/bot  hello')).toEqual({ type: 'bot', message: 'hello' })
  })

  it('rejects glued prefixes like /reviewbot and /bots', () => {
    expect(parseCommentCommand('/reviewbot x')).toEqual({ type: 'none', message: '' })
    expect(parseCommentCommand('/bots hi')).toEqual({ type: 'none', message: '' })
    expect(parseCommentCommand('/botx')).toEqual({ type: 'none', message: '' })
  })
})
