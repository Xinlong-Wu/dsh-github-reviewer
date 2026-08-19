/**
 * Account poll loop: lists open PRs per configured repository, triggers
 * reviews on new commits, and handles `/review` and `/bot` comment commands
 * on already-reviewed PRs. Review and chat turns are delegated to a
 * {@link ReviewDriver} (the agent runner), which drives them through the
 * harness agent loop and its per-PR sessions.
 * @module
 */

import type { ResolvedAccountConfig } from './config.ts'
import type { TokenSource } from './github/auth.ts'
import type { GitHubClient } from './github/client.ts'
import { GitHubRateLimitError } from './github/client.ts'
import {
  CURSOR_STATUS_MISSING_INSTRUCTIONS,
  CURSOR_STATUS_REVIEWED,
  commentCheckSince,
  cursorKey,
  markCommentCheck,
  markCursor,
  markReviewFailure,
  markReviewing,
  recordProcessedComment,
  reviewBackoffActive,
  shouldProcessCursor,
} from './github/cursor.ts'
import type { CursorState } from './github/cursor.ts'
import type { PullRequest, ReviewInstructions } from './github/model.ts'
import { fullName, parseRepository, shortSHA } from './github/model.ts'
import { sanitizeReviewPromptText } from './github/sanitizer.ts'
import { parseCommentCommand } from './github/commands.ts'
import type { CursorStore } from './cursor-store.ts'
import type { PollLogger } from './logger.ts'

export {
  cordisLogger,
  recordingLogger,
  silentLogger,
} from './logger.ts'
export type { PollLogger } from './logger.ts'

/** One review/chat driver: drives turns through the harness agent loop. */
export interface ReviewDriver {
  /** Drive one review turn; resolves with submission outcome and final text. */
  driveReview(pr: PullRequest, instructions: ReviewInstructions, signal: AbortSignal): Promise<{ submitted: boolean; text: string }>
  /** Drive one chat turn; resolves with the reply text. */
  driveChat(pr: PullRequest, message: string, signal: AbortSignal): Promise<string>
  /** Dispose every live PR agent. */
  dispose(): Promise<void>
}

/** One comment event from either comment source. */
interface CommentEvent {
  id: number
  body: string
  user: { login: string; type: string }
  /** GitHub `author_association` of the comment author. */
  authorAssociation: string
  createdAt: Date
  /** Source of the comment: issue thread or review thread. */
  replyMode: 'issue' | 'review'
  reviewCommentId: number
}

/** Runtime dependencies of one account poller. */
export interface AccountPollerDeps {
  accountName: string
  account: ResolvedAccountConfig
  client: GitHubClient
  tokenSource: TokenSource
  store: CursorStore
  driver: ReviewDriver
  logger: PollLogger
}

/** Poll loop and lifecycle for one configured GitHub account. */
export class AccountPoller {
  private readonly abortController = new AbortController()
  private running = false
  private timer: ReturnType<typeof setInterval> | undefined
  /** The currently executing tick, so dispose can wait for it. */
  private currentTick: Promise<void> | undefined
  /** Draft PRs already logged as skipped, so the line is emitted once per unchanged PR. Bounded. */
  private readonly skippedDrafts = new Map<string, true>

  /**
   * @param deps - runtime dependencies.
   */
  constructor(private readonly deps: AccountPollerDeps) {}

  /** Logger shorthand. */
  private get logger(): PollLogger {
    return this.deps.logger
  }

  /**
   * Start the poll loop: one immediate poll, then every
   * `pollIntervalMs`. Ticks skip while the previous poll still runs.
   */
  start(): void {
    this.currentTick = this.safeTick()
    this.timer = setInterval(() => {
      this.currentTick = this.safeTick()
    }, this.deps.account.pollIntervalMs)
    this.timer.unref()
  }

  /**
   * Abort in-flight work, stop the timer, wait briefly for the running tick
   * to unwind, and dispose the PR agents. Waiting keeps cursor writes from
   * racing the storage-domain close that follows in the plugin disposer.
   */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.abortController.abort()
    const tick = this.currentTick
    if (tick !== undefined) {
      let grace: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          tick,
          new Promise<void>(resolve => {
            grace = setTimeout(resolve, 5000)
            grace.unref()
          }),
        ])
      } finally {
        if (grace !== undefined) clearTimeout(grace)
      }
    }
    await this.deps.driver.dispose()
  }

  /** One tick that never rejects into the timer. */
  private async safeTick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.pollOnce(this.abortController.signal)
    } catch (error) {
      this.logger.warn(`github poll failed account=${this.deps.accountName}: ${String(error)}`)
    } finally {
      this.running = false
    }
  }

  /** One full poll pass over every configured repository. */
  async pollOnce(signal: AbortSignal): Promise<void> {
    const state = await this.deps.store.load()
    for (const repoName of this.deps.account.repositories) {
      if (signal.aborted) return
      const repo = parseRepository(repoName)
      if (repo === undefined) {
        this.logger.warn(`skipping invalid github repo account=${this.deps.accountName} repo=${repoName}`)
        continue
      }
      let prs: PullRequest[]
      try {
        prs = await this.deps.client.listOpenPullRequests(repo, signal)
      } catch (error) {
        if (this.noteRateLimited(repoName, error)) return
        this.logger.warn(`list github pull requests failed account=${this.deps.accountName} repo=${repoName}: ${String(error)}`)
        continue
      }
      this.logger.debug(`listed github pull requests account=${this.deps.accountName} repo=${repoName} count=${prs.length}`)
      for (const pr of prs) {
        if (signal.aborted) return
        if (pr.draft) {
          const skipKey = `${fullName(pr.base.repo)}#${pr.number}@${shortSHA(pr.head.sha)}:draft`
          if (this.noteSkippedDraft(skipKey)) {
            this.logger.debug(`skipping draft github pr repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
          }
          continue
        }
        // Phase 1: new commits trigger a review, unless a recent failure is still backing off.
        if (shouldProcessCursor(state, pr)) {
          const entry = state.prs[cursorKey(pr)]
          if (reviewBackoffActive(entry, pr, new Date(), this.deps.account.pollIntervalMs)) {
            this.logger.debug(
              `github review backing off repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)} failures=${entry?.failCount ?? 0}`,
            )
          } else {
            await this.executeReview(state, pr, signal)
          }
          continue
        }
        // Phase 2: comment commands on already-processed PRs.
        const entry = state.prs[cursorKey(pr)]
        if (entry === undefined) continue
        if (entry.status !== CURSOR_STATUS_REVIEWED && entry.status !== CURSOR_STATUS_MISSING_INSTRUCTIONS) continue
        try {
          await this.pollComments(state, pr, signal)
        } catch (error) {
          if (this.noteRateLimited(repoName, error)) return
          this.logger.warn(`github comment poll failed repo=${fullName(pr.base.repo)} number=${pr.number}: ${String(error)}`)
        }
      }
    }
  }

  /** Log and report whether the error is a rate limit, in which case the tick stops early. */
  private noteRateLimited(repoName: string, error: unknown): boolean {
    if (!(error instanceof GitHubRateLimitError)) return false
    const retry = error.retryAfterSeconds === undefined ? '' : ` retry_after_s=${error.retryAfterSeconds}`
    this.logger.warn(`github rate limited account=${this.deps.accountName} repo=${repoName}${retry}; skipping rest of tick`)
    return true
  }

  /** Record a skipped draft key; returns false when the key was already logged. Bounded to 500 keys. */
  private noteSkippedDraft(key: string): boolean {
    if (this.skippedDrafts.has(key)) return false
    if (this.skippedDrafts.size >= 500) {
      const oldest = this.skippedDrafts.keys().next().value
      if (oldest !== undefined) this.skippedDrafts.delete(oldest)
    }
    this.skippedDrafts.set(key, true)
    return true
  }

  /**
   * Resolve trusted review instructions with the config default fallback.
   * Three outcomes: `ok` (instructions found or defaulted), `missing`
   * (no file and no default — safe to record in the cursor), and `error`
   * (transient API failure — must NOT be recorded, so the next tick retries).
   */
  private async reviewInstructions(
    pr: PullRequest,
    signal: AbortSignal,
  ): Promise<{ kind: 'ok'; instructions: ReviewInstructions } | { kind: 'missing' } | { kind: 'error' }> {
    try {
      const outcome = await this.deps.client.reviewInstructions(pr, signal)
      if (outcome.ok && outcome.instructions !== undefined) return { kind: 'ok', instructions: outcome.instructions }
    } catch (error) {
      this.logger.warn(`read github review instructions failed repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}: ${String(error)}`)
      return { kind: 'error' }
    }
    const fallback = this.deps.account.review.defaultInstructions
    if (fallback === '') {
      this.logger.warn(`missing github review instructions repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
      return { kind: 'missing' }
    }
    this.logger.warn(
      `falling back to config default_instructions account=${this.deps.accountName} repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`,
    )
    return {
      kind: 'ok',
      instructions: {
        text: fallback,
        source: `config:github-reviewer.${this.deps.accountName}.review.defaultInstructions`,
      },
    }
  }

  /**
   * Run one review for a PR and advance the cursor. Terminal outcomes are
   * recorded: a submitted COMMENT review marks the PR reviewed, missing
   * instructions mark it accordingly, and failures are recorded with backoff
   * state so the next ticks retry with increasing delay. Transient
   * instruction-read errors leave the cursor untouched.
   */
  private async executeReview(state: CursorState, pr: PullRequest, signal: AbortSignal): Promise<void> {
    const resolved = await this.reviewInstructions(pr, signal)
    if (resolved.kind === 'error') return
    if (resolved.kind === 'missing') {
      markCursor(state, pr, CURSOR_STATUS_MISSING_INSTRUCTIONS, new Date())
      await this.deps.store.save(state)
      return
    }
    const instructions = resolved.instructions
    // Persist the in-review marker before driving the turn: a live process
    // never observes it mid-review (ticks are serialized), so finding
    // `reviewing` after a restart means the last review was interrupted and
    // must be continued (the PR's persisted session resumes the remaining work).
    markReviewing(state, pr, new Date())
    await this.deps.store.save(state)
    let outcome: { submitted: boolean; text: string }
    try {
      this.logger.info(
        `starting github review repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
        + ` instructions_source=${instructions.source}`,
      )
      outcome = await this.deps.driver.driveReview(pr, instructions, signal)
    } catch (error) {
      this.logger.warn(`github review failed repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}: ${String(error)}`)
      markReviewFailure(state, pr, new Date())
      await this.deps.store.save(state)
      return
    }
    this.logger.debug(
      `github review handler finished repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
      + ` text_len=${outcome.text.length} submitted=${outcome.submitted}`,
    )
    if (!outcome.submitted) {
      this.logger.warn(`github review completed without COMMENT submission repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
      markReviewFailure(state, pr, new Date())
      await this.deps.store.save(state)
      return
    }
    markCursor(state, pr, CURSOR_STATUS_REVIEWED, new Date())
    await this.deps.store.save(state)
    this.logger.info(`github review submitted repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
  }

  /** Poll issue and review comments for bot commands since the last check. */
  private async pollComments(state: CursorState, pr: PullRequest, signal: AbortSignal): Promise<void> {
    const entry = state.prs[cursorKey(pr)]
    const since = commentCheckSince(entry)

    const issueComments = await this.deps.client.listIssueComments(pr.base.repo, pr.number, since, signal)
    const reviewComments = await this.deps.client.listReviewComments(pr.base.repo, pr.number, since, signal)

    const events: CommentEvent[] = []
    for (const comment of issueComments) {
      if (comment.user.type.toLowerCase() === 'bot') continue
      events.push({
        id: comment.id,
        body: comment.body,
        user: comment.user,
        authorAssociation: comment.authorAssociation,
        createdAt: comment.createdAt,
        replyMode: 'issue',
        reviewCommentId: 0,
      })
    }
    for (const comment of reviewComments) {
      if (comment.user.type.toLowerCase() === 'bot') continue
      events.push({
        id: comment.id,
        body: comment.body,
        user: comment.user,
        authorAssociation: comment.authorAssociation,
        createdAt: comment.createdAt,
        replyMode: 'review',
        reviewCommentId: comment.id,
      })
    }
    events.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())

    if (events.length === 0) {
      markCommentCheck(state, pr, new Date())
      await this.deps.store.save(state)
      return
    }

    this.logger.debug(`found github pr comments repo=${fullName(pr.base.repo)} number=${pr.number} count=${events.length} since=${since?.toISOString() ?? ''}`)

    // GitHub's `since` is inclusive and second-granular, so boundary comments
    // (and edited older comments) reappear; the cursor's processed-id set
    // dedupes them across ticks. Issue and review comment ids live in
    // separate id spaces, so the key is scoped by source.
    const processed = new Set(entry?.processedCommentIds ?? [])
    for (const event of events) {
      if (signal.aborted) return
      const dedupeKey = `${event.replyMode}:${event.id}`
      if (processed.has(dedupeKey)) continue
      recordProcessedComment(state, pr, dedupeKey)
      processed.add(dedupeKey)
      if (!this.isCommandAuthorAllowed(event)) {
        const command = parseCommentCommand(event.body)
        if (command.type !== 'none') {
          this.logger.debug(
            `ignoring github comment command from unauthorized author repo=${fullName(pr.base.repo)} number=${pr.number}`
            + ` comment_id=${event.id} user=${event.user.login} association=${event.authorAssociation}`,
          )
        }
      } else {
        const command = parseCommentCommand(event.body)
        switch (command.type) {
          case 'review': {
            this.logger.info(`github re-review triggered by comment repo=${fullName(pr.base.repo)} number=${pr.number} comment_id=${event.id} user=${event.user.login}`)
            await this.executeReview(state, pr, signal)
            break
          }
          case 'bot': {
            this.logger.info(`github bot chat triggered by comment repo=${fullName(pr.base.repo)} number=${pr.number} comment_id=${event.id} user=${event.user.login}`)
            try {
              await this.handleBotChat(pr, command.message, event, signal)
            } catch (error) {
              this.logger.warn(`github bot chat failed repo=${fullName(pr.base.repo)} number=${pr.number} comment_id=${event.id}: ${String(error)}`)
            }
            break
          }
          case 'none':
            break
        }
      }
      // Advance the comment boundary after every event so a mid-batch failure
      // never replays events that were already answered.
      if (!Number.isNaN(event.createdAt.getTime())) {
        markCommentCheck(state, pr, event.createdAt)
        await this.deps.store.save(state)
      }
    }
  }

  /** Whether the comment author's association may trigger `/review` and `/bot` commands. */
  private isCommandAuthorAllowed(event: CommentEvent): boolean {
    const allowed = this.deps.account.review.commandAuthorAssociations
    if (allowed.includes('*')) return true
    return allowed.includes(event.authorAssociation.toUpperCase())
  }

  /** Answer one `/bot` comment and post the reply back to the right thread. */
  private async handleBotChat(pr: PullRequest, message: string, event: CommentEvent, signal: AbortSignal): Promise<void> {
    const sanitizedMessage = sanitizeReviewPromptText(message)
    const reply = await this.deps.driver.driveChat(pr, sanitizedMessage, signal)
    if (reply === '' || signal.aborted) return
    if (event.replyMode === 'review' && event.reviewCommentId > 0) {
      await this.deps.client.createReviewCommentReply(pr.base.repo, pr.number, event.reviewCommentId, reply, signal)
    } else {
      await this.deps.client.createIssueComment(pr.base.repo, pr.number, reply, signal)
    }
  }
}
