/**
 * Light sanitization of untrusted PR title/body text before it enters the
 * model prompt. Ported from LingoBridge: hidden HTML comments and attributes,
 * invisible/control characters, markdown image alt text, markdown link
 * titles, and secret-looking strings (GitHub tokens, AWS keys, PEM blocks)
 * are removed or redacted.
 * @module
 */

const HTML_COMMENT = /<!--[\s\S]*?-->/g
/** A real HTML tag; hidden-attribute stripping only applies inside tags. */
const HTML_TAG = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][-\w:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*\s*\/?>/g
const HIDDEN_ATTR = /\s(?:alt|title|aria-label|placeholder|data-[a-z0-9_:-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]/g
const MARKDOWN_LINK_TITLE = /(\[[^\]\n]*\]\([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))(\))/g
const HTML_ENTITY = /&#(x[0-9A-Fa-f]+|[0-9]+);?/g

/**
 * Secret-looking strings redacted before untrusted text enters prompts and
 * before model-written text leaves through comments. Kept deliberately
 * conservative: GitHub tokens, AWS access key ids, and PEM private keys.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:gh[pors]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
]

/** Matches Unicode format characters (category Cf): zero-width, bidi, tags. */
const FORMAT_CHAR = /\p{Cf}/u

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
 * Drop invisible (Unicode Cf), bidi-control, and C0/C1 control characters,
 * keeping newlines, carriage returns, and tabs.
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
    if (code < 0x20 || code === 0x7f) continue
    if (FORMAT_CHAR.test(char)) continue
    out += char
  }
  return out
}

/** Strip hidden attributes (`alt`/`title`/`aria-label`/`data-*`) inside real HTML tags only. */
function stripHiddenHtmlAttrs(value: string): string {
  return value.replace(HTML_TAG, tag => tag.replace(HIDDEN_ATTR, ''))
}

/**
 * Redact secret-looking strings (GitHub tokens, AWS access keys, PEM private
 * keys) from untrusted or model-generated text.
 * @param value - raw text.
 * @returns text with secrets replaced by a redaction marker.
 */
export function redactSecrets(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED_SECRET]')
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
  out = stripHiddenHtmlAttrs(out)
  out = out.replace(MARKDOWN_IMAGE, '![]')
  out = out.replace(MARKDOWN_LINK_TITLE, '$1$2')
  out = redactSecrets(out)
  out = stripInvisibleChars(out)
  return out.trim()
}
