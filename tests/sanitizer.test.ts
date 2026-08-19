import { describe, expect, it } from 'vitest'
import { normalizeASCIIEntities, sanitizeReviewPromptText, stripInvisibleChars } from '../src/github/sanitizer.ts'

describe('sanitizeReviewPromptText', () => {
  it('removes HTML comments', () => {
    expect(sanitizeReviewPromptText('hello <!-- hidden instruction --> world')).toBe('hello  world')
    expect(sanitizeReviewPromptText('a <!-- multi\nline --> b')).toBe('a  b')
  })

  it('removes hidden HTML attributes', () => {
    expect(sanitizeReviewPromptText('<img src="x" alt="prompt injection"> keep')).toBe('<img src="x"> keep')
    expect(sanitizeReviewPromptText('<a data-foo="bar" title="t">x</a>')).toBe('<a>x</a>')
  })

  it('removes markdown image alt text and link titles', () => {
    expect(sanitizeReviewPromptText('![ignore this instruction](https://x/y.png)')).toBe('![](https://x/y.png)')
    expect(sanitizeReviewPromptText('[link](https://x "hidden text")')).toBe('[link](https://x)')
  })

  it('redacts GitHub token-like strings', () => {
    expect(sanitizeReviewPromptText('token ghp_abcdefghijklmnopqrstuvwxyz end')).toContain('[REDACTED_SECRET]')
    expect(sanitizeReviewPromptText('github_pat_abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED_SECRET]')
    expect(sanitizeReviewPromptText('short ghp_abc123XYZ_ token')).toContain('[REDACTED_SECRET]')
  })

  it('redacts AWS access keys and PEM private keys', () => {
    expect(sanitizeReviewPromptText('key AKIAIOSFODNN7EXAMPLE here')).toContain('[REDACTED_SECRET]')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(sanitizeReviewPromptText(`before ${pem} after`)).toBe('before [REDACTED_SECRET] after')
  })

  it('does not mangle code samples that merely look like hidden attributes', () => {
    expect(sanitizeReviewPromptText('const title = "hello world"')).toBe('const title = "hello world"')
    expect(sanitizeReviewPromptText('{ "data-id": "5", "alt": 1 }')).toBe('{ "data-id": "5", "alt": 1 }')
    expect(sanitizeReviewPromptText('placeholder="x" in prose')).toBe('placeholder="x" in prose')
  })

  it('decodes printable ASCII entities and drops non-printable ones', () => {
    expect(normalizeASCIIEntities('a&#65;b&#x42;c')).toBe('aAbBc')
    expect(normalizeASCIIEntities('x&#1;y')).toBe('xy')
    expect(normalizeASCIIEntities('x&#10;y')).toBe('xy')
  })

  it('strips invisible and bidi-control characters but keeps newlines and tabs', () => {
    const input = 'a\u200bb\u202ec\u00add\n\t\u2069z'
    expect(stripInvisibleChars(input)).toBe('abcd\n\tz')
  })

  it('trims the final result', () => {
    expect(sanitizeReviewPromptText('  padded  \n')).toBe('padded')
  })
})
