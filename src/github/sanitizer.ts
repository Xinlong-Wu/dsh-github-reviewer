/**
 * Light sanitization of untrusted PR title/body text before it enters the
 * model prompt. Ported from LingoBridge: hidden HTML comments and attributes,
 * invisible/control characters, markdown image alt text, markdown link
 * titles, and GitHub token-like strings are removed or redacted.
 * @module
 */

const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_HIDDEN_ATTR = /\s(?:alt|title|aria-label|placeholder|data-[a-z0-9_:-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]/g
const MARKDOWN_LINK_TITLE = /(\[[^\]\n]*\]\([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))(\))/g
const HTML_ENTITY = /&#(x[0-9A-Fa-f]+|[0-9]+);?/g
const GITHUB_TOKEN_LIKE = /\b(?:gh[pors]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

/** Code points dropped as invisible text-control characters. */
const INVISIBLE = new Set([
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
])

/**
 * Replace printable ASCII HTML numeric entities with their characters; drop
 * entities outside the printable range.
 * @param value - raw text.
 * @returns text with printable entities decoded.
 */
export function normalizeASCIIEntities(value: string): string {
  return value.replace(HTML_ENTITY, (match, raw: string) => {
    const isHex = raw[0] === 'x' || raw[0] === 'X'
    const parsed = Number.parseInt(isHex ? raw.slice(1) : raw, isHex ? 16 : 10)
    if (!Number.isFinite(parsed) || parsed < 32 || parsed > 126) return ''
    return String.fromCodePoint(parsed)
  })
}

/**
 * Drop invisible and bidi-control characters, keeping newlines, carriage
 * returns, and tabs.
 * @param value - raw text.
 * @returns text without invisible characters.
 */
export function stripInvisibleChars(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n' || char === '\r' || char === '\t') {
      out += char
      continue
    }
    if (INVISIBLE.has(code)) continue
    if (code < 0x20 || code === 0x7f) continue
    if (code >= 0x202a && code <= 0x202e) continue
    if (code >= 0x2066 && code <= 0x2069) continue
    out += char
  }
  return out
}

/**
 * Sanitize untrusted PR title or body text for prompt placement.
 * @param value - raw GitHub text.
 * @returns trimmed, sanitized text.
 */
export function sanitizeReviewPromptText(value: string): string {
  let out = normalizeASCIIEntities(value)
  out = out.replace(HTML_COMMENT, '')
  out = out.replace(HTML_HIDDEN_ATTR, '')
  out = out.replace(MARKDOWN_IMAGE, '![]')
  out = out.replace(MARKDOWN_LINK_TITLE, '$1$2')
  out = out.replace(GITHUB_TOKEN_LIKE, '[REDACTED_GITHUB_TOKEN]')
  out = stripInvisibleChars(out)
  return out.trim()
}
