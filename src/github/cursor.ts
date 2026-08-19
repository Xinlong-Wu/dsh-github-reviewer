/**
 * Review cursor: durable per-account state that decides which PRs need a
 * review and how far comment polling has reached. Ported from LingoBridge's
 * `sync_cursors` buffer, persisted as one storage-domain record per account
 * (see `src/cursor-store.ts`).
 * @module
 */

import type { PullRequest } from './model.ts'
import { fullName } from './model.ts'

/** A PR that received a successful COMMENT review submission. */
export const CURSOR_STATUS_REVIEWED = 'reviewed'
/** A PR whose review instructions were missing: retry only when the head SHA changes. */
export const CURSOR_STATUS_MISSING_INSTRUCTIONS = 'missing_instructions'
/**
 * A PR whose review was started but not finished: the poller records this
 * before driving the review turn. A live process never observes it mid-review
 * (ticks are serialized), so a persisted `reviewing` entry means the last
 * review was interrupted — the next tick re-runs the review, which resumes
 * the PR's persisted session and continues the remaining work.
 */
export const CURSOR_STATUS_REVIEWING = 'reviewing'

/** Valid `status` values on a {@link CursorEntry}. */
export type CursorStatus =
  | typeof CURSOR_STATUS_REVIEWED
  | typeof CURSOR_STATUS_MISSING_INSTRUCTIONS
  | typeof CURSOR_STATUS_REVIEWING

/** Upper bound for the review-failure backoff delay. */
export const MAX_REVIEW_FAILURE_BACKOFF_MS = 30 * 60_000

/** Per-PR cursor entry. */
export interface CursorEntry {
  /** Head SHA the entry was recorded against. */
  headSHA: string
  /** Terminal status; absent when no terminal status was reached yet (e.g. only failures so far). */
  status?: CursorStatus
  /** RFC 3339 timestamp of the last status update. */
  updatedAt?: string
  /** RFC 3339 timestamp of the last comment poll. */
  lastCommentCheck?: string
  /** Head SHA of the last failed review attempt, when it differs from a terminal status. */
  lastFailedSHA?: string
  /** Consecutive failed review attempts against {@link CursorEntry.lastFailedSHA}. */
  failCount?: number
  /** RFC 3339 timestamp of the last failed review attempt. */
  lastFailedAt?: string
  /**
   * Recently processed comment keys (`issue:<id>` / `review:<id>`), capped at
   * {@link MAX_PROCESSED_COMMENT_IDS}. GitHub timestamps are second-granular,
   * so time-only dedupe would drop or replay comments; this set dedupes across ticks.
   */
  processedCommentIds?: string[]
}

/** Cap for {@link CursorEntry.processedCommentIds}. */
export const MAX_PROCESSED_COMMENT_IDS = 50

/** Whole cursor record: PR entries keyed by `owner/repo#number`. */
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
  // `reviewing` (interrupted review) and status-less failure entries both
  // still need processing; only terminal states are skipped.
  return entry.status !== CURSOR_STATUS_REVIEWED && entry.status !== CURSOR_STATUS_MISSING_INSTRUCTIONS
}

/**
 * Record a terminal review status for a PR, resetting the comment-check clock
 * and clearing any recorded review-failure state.
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
 * Record that a review attempt is starting, preserving any failure/backoff
 * state so a failed attempt still escalates the backoff on the same SHA.
 * @param state - cursor to update in place.
 * @param pr - the pull request being reviewed.
 * @param now - current instant.
 */
export function markReviewing(state: CursorState, pr: PullRequest, now: Date): void {
  const entry = state.prs[cursorKey(pr)]
  state.prs[cursorKey(pr)] = {
    ...entry,
    headSHA: entry?.headSHA ?? pr.head.sha.trim(),
    status: CURSOR_STATUS_REVIEWING,
    updatedAt: now.toISOString(),
    lastCommentCheck: now.toISOString(),
  }
}

/**
 * Record a failed review attempt against the current head SHA, preserving any
 * terminal status the entry already carries. Consecutive failures against the
 * same SHA accumulate {@link CursorEntry.failCount} for backoff.
 * @param state - cursor to update in place.
 * @param pr - the pull request whose review failed.
 * @param now - current instant.
 */
export function markReviewFailure(state: CursorState, pr: PullRequest, now: Date): void {
  const failedSHA = pr.head.sha.trim()
  const entry = state.prs[cursorKey(pr)]
  const failCount = entry !== undefined && entry.lastFailedSHA === failedSHA ? (entry.failCount ?? 0) + 1 : 1
  state.prs[cursorKey(pr)] = {
    ...entry,
    headSHA: entry?.headSHA ?? failedSHA,
    lastFailedSHA: failedSHA,
    failCount,
    lastFailedAt: now.toISOString(),
  }
}

/**
 * Whether a failed review of the current head SHA is still backing off. The
 * delay doubles per consecutive failure (`2^failCount * baseDelayMs`), capped
 * at {@link MAX_REVIEW_FAILURE_BACKOFF_MS}.
 * @param entry - the PR cursor entry, if any.
 * @param pr - the pull request under consideration.
 * @param now - current instant.
 * @param baseDelayMs - base delay unit, typically the account's poll interval.
 */
export function reviewBackoffActive(entry: CursorEntry | undefined, pr: PullRequest, now: Date, baseDelayMs: number): boolean {
  if (entry === undefined || entry.lastFailedAt === undefined) return false
  if (entry.lastFailedSHA !== pr.head.sha.trim()) return false
  const failedAt = new Date(entry.lastFailedAt)
  if (Number.isNaN(failedAt.getTime())) return false
  const exponent = Math.min(entry.failCount ?? 1, 10)
  const delay = Math.min(2 ** exponent * baseDelayMs, MAX_REVIEW_FAILURE_BACKOFF_MS)
  return now.getTime() - failedAt.getTime() < delay
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
 * Record a processed comment id for cross-tick dedupe, keeping only the most
 * recent {@link MAX_PROCESSED_COMMENT_IDS} entries.
 * @param state - cursor to update in place.
 * @param pr - the pull request.
 * @param idKey - the scoped comment key, e.g. `issue:123` or `review:456`.
 */
export function recordProcessedComment(state: CursorState, pr: Pick<PullRequest, 'number' | 'base'>, idKey: string): void {
  const entry = state.prs[cursorKey(pr)]
  if (entry === undefined) return
  const ids = entry.processedCommentIds ?? []
  if (!ids.includes(idKey)) ids.push(idKey)
  while (ids.length > MAX_PROCESSED_COMMENT_IDS) ids.shift()
  entry.processedCommentIds = ids
}
