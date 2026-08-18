/**
 * Account poll loop: lists open PRs per configured repository, triggers
 * reviews on new commits, and handles `/review` and `/bot` comment commands
 * on already-reviewed PRs. Ported from LingoBridge's `Platform.pollOnce` and
 * `pollComments`.
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
import type { GuardLogger } from './github/guard.ts'
import { guardReviewTools, ReviewGuardState } from './github/guard.ts'
import type { PullRequest, ReviewInstructions } from './github/model.ts'
import { fullName, parseRepository, shortSHA } from './github/model.ts'
import { StdioMcpHost } from './github/mcp-host.ts'
import type { McpHost } from './github/mcp-host.ts'
import { pullRequestUserKey } from './github/prompts.ts'
import { sanitizeReviewPromptText } from './github/sanitizer.ts'
import { parseCommentCommand } from './github/commands.ts'
import { runChat, runReview } from './review.ts'
import type { LlmStreamer, OrchestratorLogger } from './review.ts'
import type { JsonFileCursorStore } from './state-file.ts'

/** Poll diagnostics observer. */
export interface PollLogger extends OrchestratorLogger {}

/** Logger adapter binding the poller to a Cordis logger. */
export function cordisLogger(logger: {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}): PollLogger {
  return {
    debug: message => logger.debug(message),
    info: message => logger.info(message),
    warn: message => logger.warn(message),
    error: message => logger.error(message),
  }
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
  llm: LlmStreamer
  client: GitHubClient
  tokenSource: TokenSource
  store: JsonFileCursorStore
  logger: PollLogger
  /** Optional MCP host factory override, for tests. */
  mcpHostFactory?: (token: string, signal: AbortSignal) => Promise<McpHost>
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

  /** Abort in-flight work and stop the timer. */
  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.abortController.abort()
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
    let submitted: boolean
    try {
      submitted = await this.runReviewOnce(pr, instructions, signal)
    } catch (error) {
      this.logger.warn(`github review failed repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}: ${String(error)}`)
      return
    }
    if (!submitted) {
      this.logger.warn(`github review completed without COMMENT submission repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
      return
    }
    markCursor(state, pr, CURSOR_STATUS_REVIEWED, new Date())
    await this.deps.store.save(state)
    this.logger.info(`github review submitted repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`)
  }

  /** Spawn the per-review MCP host and drive one review conversation. */
  private async runReviewOnce(pr: PullRequest, instructions: ReviewInstructions, signal: AbortSignal): Promise<boolean> {
    const token = await this.deps.tokenSource.token(signal)
    const host = await this.connectMcpHost(token, signal)
    try {
      const rawTools = await host.listTools(signal)
      const state = new ReviewGuardState()
      const tools = guardReviewTools(rawTools, pr, state, host, this.logger)
      if (tools.length === 0) {
        throw new Error('github mcp host exposed no allowed PR review tools')
      }
      this.logger.info(
        `starting github review repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
        + ` tools=${tools.length} instructions_source=${instructions.source}`,
      )
      this.logger.debug(`using shared github pr session repo=${fullName(pr.base.repo)} number=${pr.number} flow=review session_key=${pullRequestUserKey(pr)}`)
      const submitted = await runReview(
        this.deps.llm,
        pr,
        instructions,
        this.deps.account.provider,
        this.deps.account.model,
        tools,
        this.deps.account.review,
        state,
        this.logger,
        signal,
      )
      this.logger.debug(
        `github review handler finished repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
        + ` pending_created=${state.pendingReviewCreated} comment_attempted=${state.inlineCommentsAttempted}`
        + ` comment_added=${state.inlineCommentsAdded} submit_attempted=${state.submitAttempted}`
        + ` submitted=${state.submittedComment} write_attempted=${state.writeAttempted}`,
      )
      return submitted
    } finally {
      await host.close()
    }
  }

  /** Connect the per-review MCP server with token and host injected. */
  private async connectMcpHost(token: string, signal: AbortSignal): Promise<McpHost> {
    const factory = this.deps.mcpHostFactory
    if (factory !== undefined) return factory(token, signal)
    const account = this.deps.account
    const env: Record<string, string> = { ...account.mcp.env }
    env.GITHUB_PERSONAL_ACCESS_TOKEN = token
    if (account.webUrl !== '') env.GITHUB_HOST = account.webUrl
    return StdioMcpHost.connect(
      { command: account.mcp.command, args: account.mcp.args, env, cwd: account.mcp.cwd },
      account.review.toolTimeoutMs,
      account.review.toolResultLimit,
      signal,
    )
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
          let submitted: boolean
          try {
            submitted = await this.runReviewOnce(pr, resolved.instructions as ReviewInstructions, signal)
          } catch (error) {
            this.logger.warn(`github re-review failed repo=${fullName(pr.base.repo)} number=${pr.number}: ${String(error)}`)
            break
          }
          if (submitted) {
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
    const token = await this.deps.tokenSource.token(signal)
    const host = await this.connectMcpHost(token, signal)
    try {
      const rawTools = await host.listTools(signal)
      const state = new ReviewGuardState()
      const tools = guardReviewTools(rawTools, pr, state, host, this.logger)
      const sanitizedMessage = sanitizeReviewPromptText(message)
      this.logger.debug(`using shared github pr session repo=${fullName(pr.base.repo)} number=${pr.number} flow=chat session_key=${pullRequestUserKey(pr)}`)
      const reply = await runChat(
        this.deps.llm,
        pr,
        sanitizedMessage,
        this.deps.account.provider,
        this.deps.account.model,
        tools,
        this.deps.account.review,
        this.logger,
        signal,
      )
      if (reply === '') return
      if (event.replyMode === 'review' && event.reviewCommentId > 0) {
        await this.deps.client.createReviewCommentReply(pr.base.repo, pr.number, event.reviewCommentId, reply, signal)
      } else {
        await this.deps.client.createIssueComment(pr.base.repo, pr.number, reply, signal)
      }
    } finally {
      await host.close()
    }
  }
}

/** A logger that discards everything, for tests. */
export function silentLogger(): PollLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

/** A logger that records lines, for tests. */
export function recordingLogger(lines: string[]): PollLogger {
  return {
    debug: message => lines.push(`debug: ${message}`),
    info: message => lines.push(`info: ${message}`),
    warn: message => lines.push(`warn: ${message}`),
    error: message => lines.push(`error: ${message}`),
  }
}

/** Export guard logger type re-exported for consumers. */
export type { GuardLogger } from './github/guard.ts'
