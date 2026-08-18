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
import {
  CURSOR_STATUS_MISSING_INSTRUCTIONS,
  CURSOR_STATUS_REVIEWED,
  commentCheckSince,
  cursorKey,
  markCommentCheck,
  markCursor,
  shouldProcessCursor,
} from './github/cursor.ts'
import type { CursorState } from './github/cursor.ts'
import type { PullRequest, ReviewInstructions } from './github/model.ts'
import { fullName, parseRepository, shortSHA } from './github/model.ts'
import { sanitizeReviewPromptText } from './github/sanitizer.ts'
import { parseCommentCommand } from './github/commands.ts'
import type { PollLogger } from './logger.ts'
import type { JsonFileCursorStore } from './state-file.ts'

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
  store: JsonFileCursorStore
  driver: ReviewDriver
  logger: PollLogger
}

/** Poll loop and lifecycle for one configured GitHub account. */
export class AccountPoller {
  private readonly abortController = new AbortController()
  private running = false
  private timer: ReturnType<typeof setInterval> | undefined
  /** Draft PRs already logged as skipped, so the line is emitted once per unchanged PR. */
  private readonly skippedDrafts = new Set<string>()

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
    void this.safeTick()
    this.timer = setInterval(() => void this.safeTick(), this.deps.account.pollIntervalMs)
    this.timer.unref()
  }

  /** Abort in-flight work, stop the timer, and dispose the PR agents. */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.abortController.abort()
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
        this.logger.warn(`list github pull requests failed account=${this.deps.accountName} repo=${repoName}: ${String(error)}`)
        continue
      }
      this.logger.debug(`listed github pull requests account=${this.deps.accountName} repo=${repoName} count=${prs.length}`)
      for (const pr of prs) {
        if (signal.aborted) return
        if (pr.draft) {
          const skipKey = `${fullName(pr.base.repo)}#${pr.number}@${shortSHA(pr.head.sha)}:draft`
          if (!this.skippedDrafts.has(skipKey)) {
            this.logger.debug(`skipping draft github pr repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
            this.skippedDrafts.add(skipKey)
          }
          continue
        }
        // Phase 1: new commits trigger a review.
        if (shouldProcessCursor(state, pr)) {
          await this.processReview(state, pr, signal)
          continue
        }
        // Phase 2: comment commands on already-processed PRs.
        const entry = state.prs[cursorKey(pr)]
        if (entry === undefined) continue
        if (entry.status !== CURSOR_STATUS_REVIEWED && entry.status !== CURSOR_STATUS_MISSING_INSTRUCTIONS) continue
        try {
          await this.pollComments(state, pr, signal)
        } catch (error) {
          this.logger.warn(`github comment poll failed repo=${fullName(pr.base.repo)} number=${pr.number}: ${String(error)}`)
        }
      }
    }
  }

  /** Resolve trusted review instructions with the config default fallback. */
  private async reviewInstructions(pr: PullRequest, signal: AbortSignal): Promise<{ instructions?: ReviewInstructions; ok: boolean }> {
    let outcome: { instructions?: ReviewInstructions; ok: boolean }
    try {
      outcome = await this.deps.client.reviewInstructions(pr, signal)
    } catch (error) {
      this.logger.warn(`read github review instructions failed repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}: ${String(error)}`)
      return { ok: false }
    }
    if (outcome.ok && outcome.instructions !== undefined) return outcome
    const fallback = this.deps.account.review.defaultInstructions
    if (fallback === '') {
      this.logger.warn(`missing github review instructions repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
      return { ok: false }
    }
    this.logger.warn(
      `falling back to config default_instructions account=${this.deps.accountName} repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`,
    )
    return {
      instructions: {
        text: fallback,
        source: `config:github-reviewer.accounts.${this.deps.accountName}.review.defaultInstructions`,
      },
      ok: true,
    }
  }

  /** Run one review for a PR and advance the cursor when a COMMENT review lands. */
  private async processReview(state: CursorState, pr: PullRequest, signal: AbortSignal): Promise<void> {
    const resolved = await this.reviewInstructions(pr, signal)
    if (!resolved.ok) {
      markCursor(state, pr, CURSOR_STATUS_MISSING_INSTRUCTIONS, new Date())
      await this.deps.store.save(state)
      return
    }
    const instructions = resolved.instructions as ReviewInstructions
    let outcome: { submitted: boolean; text: string }
    try {
      this.logger.info(
        `starting github review repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
        + ` instructions_source=${instructions.source}`,
      )
      outcome = await this.deps.driver.driveReview(pr, instructions, signal)
    } catch (error) {
      this.logger.warn(`github review failed repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}: ${String(error)}`)
      return
    }
    this.logger.debug(
      `github review handler finished repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
      + ` text_len=${outcome.text.length} submitted=${outcome.submitted}`,
    )
    if (!outcome.submitted) {
      this.logger.warn(`github review completed without COMMENT submission repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
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

    for (const event of events) {
      if (signal.aborted) return
      const command = parseCommentCommand(event.body)
      switch (command.type) {
        case 'review': {
          this.logger.info(`github re-review triggered by comment repo=${fullName(pr.base.repo)} number=${pr.number} comment_id=${event.id} user=${event.user.login}`)
          const resolved = await this.reviewInstructions(pr, signal)
          if (!resolved.ok) {
            markCursor(state, pr, CURSOR_STATUS_MISSING_INSTRUCTIONS, new Date())
            await this.deps.store.save(state)
            return
          }
          let outcome: { submitted: boolean; text: string }
          try {
            outcome = await this.deps.driver.driveReview(pr, resolved.instructions as ReviewInstructions, signal)
          } catch (error) {
            this.logger.warn(`github re-review failed repo=${fullName(pr.base.repo)} number=${pr.number}: ${String(error)}`)
            break
          }
          if (outcome.submitted) {
            markCursor(state, pr, CURSOR_STATUS_REVIEWED, new Date())
            await this.deps.store.save(state)
            this.logger.info(`github re-review submitted repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
          }
          // After /review, skip remaining comments — the re-review covers latest state.
          return
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

    markCommentCheck(state, pr, new Date())
    await this.deps.store.save(state)
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
