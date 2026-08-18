/**
 * Bot command parsing for PR comments: `/review` triggers a re-review and
 * `/bot <message>` continues the PR conversation. Ported from LingoBridge.
 * @module
 */

/** Command type tag: re-review, chat, or no command. */
export type CommentCommandType = 'review' | 'bot' | 'none'

/** A parsed bot command from a PR comment body. */
export interface CommentCommand {
  type: CommentCommandType
  /** For `bot` commands, the message text; empty otherwise. */
  message: string
}

/**
 * Extract a bot command from a comment body. Only the first line is scanned
 * for the command; a multi-line `/bot` message keeps the full body after the
 * command.
 * @param body - raw comment body.
 * @returns the parsed command, or a `none` command.
 */
export function parseCommentCommand(body: string): CommentCommand {
  const trimmed = body.trim()
  if (trimmed === '') return { type: 'none', message: '' }

  const newline = trimmed.indexOf('\n')
  const firstLine = (newline >= 0 ? trimmed.slice(0, newline) : trimmed).trim()
  if (firstLine === '') return { type: 'none', message: '' }

  const lower = firstLine.toLowerCase()

  if (lower === '/review' || lower.startsWith('/review ')) {
    return { type: 'review', message: '' }
  }

  if (lower.startsWith('/bot ')) {
    let message = firstLine.slice('/bot '.length).trim()
    if (newline >= 0) {
      const fullMessage = trimmed.slice('/bot '.length).trim()
      if (fullMessage !== '') message = fullMessage
    }
    if (message === '') return { type: 'none', message: '' }
    return { type: 'bot', message }
  }

  return { type: 'none', message: '' }
}
