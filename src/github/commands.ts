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
 * command. Any whitespace (spaces, tabs) may separate the command token.
 * @param body - raw comment body.
 * @returns the parsed command, or a `none` command.
 */
export function parseCommentCommand(body: string): CommentCommand {
  const trimmed = body.trim()
  if (trimmed === '') return { type: 'none', message: '' }

  const match = /^\/(review|bot)(?=\s|$)/i.exec(trimmed)
  if (match === null) return { type: 'none', message: '' }

  const command = match[1].toLowerCase()
  if (command === 'review') return { type: 'review', message: '' }

  const message = trimmed.slice(match[0].length).trim()
  if (message === '') return { type: 'none', message: '' }
  return { type: 'bot', message }
}
