/**
 * Review cursor: durable per-account state that decides which PRs need a
 * review and how far comment polling has reached. Ported from LingoBridge's
 * `sync_cursors` buffer, backed here by one JSON file per account.
 * @module
 */

import type { PullRequest } from './model.ts'
import { fullName } from './model.ts'

/** A PR that received a successful COMMENT review submission. */
export const CURSOR_STATUS_REVIEWED = 'reviewed'
/** A PR whose review instructions were missing: retry only when the head SHA changes. */
export const CURSOR_STATUS_MISSING_INSTRUCTIONS = 'missing_instructions'

/** Valid `status` values on a {@link CursorEntry}. */
export type CursorStatus =
  | typeof CURSOR_STATUS_REVIEWED
  | typeof CURSOR_STATUS_MISSING_INSTRUCTIONS

/** Per-PR cursor entry. */
export interface CursorEntry {
  /** Head SHA the entry was recorded against. */
  headSHA: string
  status: CursorStatus
  /** RFC 3339 timestamp of the last status update. */
  updatedAt?: string
  /** RFC 3339 timestamp of the last comment poll. */
  lastCommentCheck?: string
}

/** Whole cursor file: PR entries keyed by `owner/repo#number`. */
export interface CursorState {
  prs: Record<string, CursorEntry>
}

/** An empty cursor. */
export function emptyCursorState(): CursorState {
  return { prs: {} }
}

/** Stable key for one PR: base repo plus number. */
export function cursorKey(pr: Pick<PullRequest, 'number' | 'base'>): string {
  return `${fullName(pr.base.repo)}#${pr.number}`
}

/**
 * Whether this PR needs a review pass: a new key, a changed head SHA, or a
 * previous pass that did not reach a terminal status.
 * @param state - loaded cursor state.
 * @param pr - the pull request under consideration.
 */
export function shouldProcessCursor(state: CursorState, pr: PullRequest): boolean {
  const entry = state.prs[cursorKey(pr)]
  if (entry === undefined) return true
  if (entry.headSHA.trim() !== pr.head.sha.trim()) return true
  return entry.status !== CURSOR_STATUS_REVIEWED && entry.status !== CURSOR_STATUS_MISSING_INSTRUCTIONS
}

/**
 * Record a terminal review status for a PR, resetting the comment-check clock.
 * @param state - cursor to update in place.
 * @param pr - the pull request.
 * @param status - terminal status to record.
 * @param now - current instant.
 */
export function markCursor(state: CursorState, pr: PullRequest, status: CursorStatus, now: Date): void {
  const nowStr = now.toISOString()
  state.prs[cursorKey(pr)] = {
    headSHA: pr.head.sha.trim(),
    status,
    updatedAt: nowStr,
    lastCommentCheck: nowStr,
  }
}

/**
 * The effective `since` instant for the next comment poll, preferring the
 * last comment check and falling back to the last status update.
 * @param entry - the PR cursor entry.
 * @returns the instant, or undefined when neither timestamp parses.
 */
export function commentCheckSince(entry: CursorEntry): Date | undefined {
  for (const value of [entry.lastCommentCheck, entry.updatedAt]) {
    const trimmed = value?.trim()
    if (trimmed === undefined || trimmed === '') continue
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return undefined
}

/**
 * Update only the comment-check timestamp, leaving status and head SHA intact.
 * @param state - cursor to update in place.
 * @param pr - the pull request.
 * @param now - current instant.
 */
export function markCommentCheck(state: CursorState, pr: Pick<PullRequest, 'number' | 'base'>, now: Date): void {
  const entry = state.prs[cursorKey(pr)]
  if (entry === undefined) return
  entry.lastCommentCheck = now.toISOString()
}

/**
 * Decode a raw cursor file body into cursor state.
 * @param body - raw JSON file content.
 * @returns the decoded state; an empty body decodes to an empty cursor.
 * @throws when the JSON is malformed.
 */
export function decodeCursor(body: string): CursorState {
  if (body.trim() === '') return emptyCursorState()
  const parsed = JSON.parse(body) as Partial<CursorState>
  if (typeof parsed !== 'object' || parsed === null) throw new Error('github reviewer cursor is not a JSON object')
  const prs = parsed.prs
  if (prs === undefined) return emptyCursorState()
  if (typeof prs !== 'object' || prs === null || Array.isArray(prs)) {
    throw new Error('github reviewer cursor "prs" is not a JSON object')
  }
  return { prs: prs as CursorState['prs'] }
}

/**
 * Encode cursor state as the file body.
 * @param state - cursor to encode.
 * @returns stable JSON with sorted keys.
 */
export function encodeCursor(state: CursorState): string {
  const prs: Record<string, CursorEntry> = {}
  for (const key of Object.keys(state.prs).sort()) {
    const entry = state.prs[key]
    prs[key] = {
      headSHA: entry.headSHA,
      status: entry.status,
      ...entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt },
      ...entry.lastCommentCheck === undefined ? {} : { lastCommentCheck: entry.lastCommentCheck },
    }
  }
  return `${JSON.stringify({ prs }, null, 2)}\n`
}
