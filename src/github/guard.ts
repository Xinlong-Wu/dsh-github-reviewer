/**
 * PR-review tool guard: wraps GitHub MCP tools exposed to the model so every
 * call must target the current PR, reads are limited to allowed methods and
 * refs, and writes are limited to the COMMENT pending-review workflow.
 * Ported from LingoBridge's `guardReviewTools`.
 * @module
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PullRequest, Repository } from './model.ts'
import { fullName, sameRepo, shortSHA } from './model.ts'

/** Prefix of model-facing guarded tool names (`mcp_github_<remote>`). */
export const GITHUB_MCP_TOOL_PREFIX = 'mcp_github_'

/** Remote tool names (after the prefix) allowed in an automated review. */
const ALLOWED_REVIEW_REMOTE_TOOLS = new Set([
  'pull_request_read',
  'get_file_contents',
  'pull_request_review_write',
  'add_comment_to_pending_review',
])

/** `pull_request_read` methods allowed in an automated review. */
const ALLOWED_REVIEW_READ_METHODS = new Set(['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs'])
const ALLOWED_REVIEW_READ_METHOD_LIST = ['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs']

/** Log-line cap for error summaries. */
const REVIEW_LOG_TEXT_LIMIT = 500

/** One MCP tool as discovered from the server, before guarding. */
export interface RawMcpTool {
  /** Remote tool name, e.g. `pull_request_read`. */
  name: string
  description: string
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>
}

/** Outcome of one guarded tool execution. */
export interface GuardedToolResult {
  /** Result text sent back to the model (already bounded). */
  content: string
  isError: boolean
}

/**
 * Write-tracking state for one review run. The caller reads
 * {@link submittedComment} to decide whether the cursor may be marked
 * reviewed.
 */
export class ReviewGuardState {
  submittedComment = false
  writeAttempted = false
  pendingReviewCreated = false
  inlineCommentsAttempted = 0
  inlineCommentsAdded = 0
  submitAttempted = false
}

/** Log observer used by the guard for normalized-call diagnostics. */
export interface GuardLogger {
  warn(message: string): void
  debug(message: string): void
}

/** Strip the `mcp_github_` prefix, returning the remote tool name. */
function githubRemoteToolName(exposed: string): string | undefined {
  const trimmed = exposed.trim()
  if (!trimmed.startsWith(GITHUB_MCP_TOOL_PREFIX)) return undefined
  const remote = trimmed.slice(GITHUB_MCP_TOOL_PREFIX.length)
  return remote === '' ? undefined : remote
}

function stringArg(args: Record<string, unknown>, key: string): { value: string; ok: boolean } {
  const value = args[key]
  if (value === undefined || value === null) return { value: '', ok: false }
  if (typeof value !== 'string') return { value: '', ok: false }
  const trimmed = value.trim()
  return { value: trimmed, ok: trimmed !== '' }
}

function intArg(args: Record<string, unknown>, key: string): { value: number; ok: boolean } {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return { value: 0, ok: false }
  return { value, ok: true }
}

/** Collapse whitespace and bound a log text summary. */
function summarizeReviewLogText(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}...`
}

function reviewLogTextChars(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length
}

function validReviewCommentSide(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === 'LEFT' || trimmed === 'RIGHT'
}

/** Whether this is a `submit_pending` with `event=COMMENT`. */
function isCommentSubmit(args: Record<string, unknown>): boolean {
  const method = stringArg(args, 'method').value
  const event = stringArg(args, 'event').value
  return method === 'submit_pending' && event === 'COMMENT'
}

/**
 * Validate the common owner/repo/pullNumber arguments against the current PR.
 * @param args - tool arguments.
 * @param pr - the PR under review.
 */
function validateBasePRArgs(args: Record<string, unknown>, pr: PullRequest): void {
  const owner = stringArg(args, 'owner')
  const repo = stringArg(args, 'repo')
  const pullNumber = intArg(args, 'pullNumber')
  if (!owner.ok) throw new Error('owner is required')
  if (!repo.ok) throw new Error('repo is required')
  if (!pullNumber.ok) throw new Error('pullNumber is required')
  if (!sameRepo({ owner: owner.value, name: repo.value }, pr.base.repo) || pullNumber.value !== pr.number) {
    throw new Error(`tool call must target current PR ${fullName(pr.base.repo)}#${pr.number}`)
  }
}

function validatePullRequestReadArgs(args: Record<string, unknown>, pr: PullRequest): void {
  validateBasePRArgs(args, pr)
  const method = stringArg(args, 'method')
  if (!method.ok) throw new Error('method is required')
  if (!ALLOWED_REVIEW_READ_METHODS.has(method.value)) {
    throw new Error(`pull_request_read method "${method.value}" is not allowed for automated PR review`)
  }
}

function allowedReviewSHA(value: string, pr: PullRequest): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && (trimmed === pr.base.sha.trim() || trimmed === pr.head.sha.trim())
}

function branchRefMatches(value: string, branch: string): boolean {
  const trimmed = branch.trim()
  if (trimmed === '') return false
  return value === trimmed || value === `refs/heads/${trimmed}`
}

function allowedReviewRef(value: string, target: Repository, pr: PullRequest): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  if (allowedReviewSHA(trimmed, pr)) return true
  if (sameRepo(target, pr.base.repo) && branchRefMatches(trimmed, pr.base.ref)) return true
  if (sameRepo(target, pr.head.repo) && branchRefMatches(trimmed, pr.head.ref)) return true
  return sameRepo(target, pr.base.repo) && trimmed === `refs/pull/${pr.number}/head`
}

function validateFileContentsArgs(args: Record<string, unknown>, pr: PullRequest): void {
  const owner = stringArg(args, 'owner')
  const repo = stringArg(args, 'repo')
  if (!owner.ok) throw new Error('owner is required')
  if (!repo.ok) throw new Error('repo is required')
  const target = { owner: owner.value, name: repo.value }
  if (!sameRepo(target, pr.base.repo) && !sameRepo(target, pr.head.repo)) {
    throw new Error('get_file_contents may only target current PR base/head repositories')
  }

  const sha = stringArg(args, 'sha')
  const ref = stringArg(args, 'ref')
  if (sha.ok && ref.ok) throw new Error('get_file_contents must not include both sha and ref')
  if (sha.ok) {
    if (!allowedReviewSHA(sha.value, pr)) {
      throw new Error('get_file_contents sha must be current PR base or head SHA')
    }
    return
  }
  if (ref.ok) {
    if (!allowedReviewRef(ref.value, target, pr)) {
      throw new Error(
        `get_file_contents ref must be current PR base/head branch ref, refs/pull/${pr.number}/head, or current PR base/head SHA`,
      )
    }
    return
  }
  args.sha = pr.head.sha
  delete args.ref
}

function keepReviewCreateArgs(args: Record<string, unknown>): number {
  let dropped = 0
  for (const key of Object.keys(args)) {
    if (key === 'owner' || key === 'repo' || key === 'pullNumber' || key === 'method' || key === 'commitID') continue
    delete args[key]
    dropped++
  }
  return dropped
}

function validateReviewWriteArgs(args: Record<string, unknown>, pr: PullRequest, logger: GuardLogger): void {
  validateBasePRArgs(args, pr)
  const method = stringArg(args, 'method')
  if (!method.ok) throw new Error('method is required')
  switch (method.value) {
    case 'create': {
      const hadEvent = args.event !== undefined
      const body = stringArg(args, 'body')
      const hadRawBody = args.body !== undefined
      const bodyChars = reviewLogTextChars(body.value)
      delete args.event
      delete args.body

      const expectedCommitID = pr.head.sha.trim()
      const commitID = stringArg(args, 'commitID')
      if (commitID.ok && commitID.value.trim() !== expectedCommitID) {
        throw new Error('pull_request_review_write commitID must be current PR head SHA')
      }
      const injectedCommitID = !commitID.ok
      if (injectedCommitID) args.commitID = expectedCommitID
      const droppedExtraArgs = keepReviewCreateArgs(args)
      if (hadEvent || hadRawBody || injectedCommitID || droppedExtraArgs > 0) {
        logger.warn(
          `normalized create review repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
          + ` dropped_event=${hadEvent} dropped_body=${hadRawBody} dropped_extra_args=${droppedExtraArgs}`
          + ` injected_commit_id=${injectedCommitID} body_chars=${bodyChars}`,
        )
      }
      return
    }
    case 'submit_pending': {
      const event = stringArg(args, 'event')
      if (!event.ok || event.value !== 'COMMENT') {
        throw new Error('pull_request_review_write submit_pending is only allowed with event=COMMENT')
      }
      return
    }
    default:
      throw new Error(`pull_request_review_write method "${method.value}" is not allowed`)
  }
}

function validateReviewCommentArgs(args: Record<string, unknown>): void {
  const path = stringArg(args, 'path')
  if (!path.ok) throw new Error('path is required')
  if (path.value.startsWith('/') || path.value.includes('\0') || path.value.includes('..')) {
    throw new Error('path must be a relative repository path')
  }
  const body = stringArg(args, 'body')
  if (!body.ok) throw new Error('body is required')
  const subjectType = stringArg(args, 'subjectType')
  if (!subjectType.ok) throw new Error('subjectType is required')
  switch (subjectType.value) {
    case 'FILE': {
      if (intArg(args, 'startLine').ok) throw new Error('startLine is only allowed for LINE comments')
      if (stringArg(args, 'startSide').ok) throw new Error('startSide is only allowed for LINE comments')
      return
    }
    case 'LINE': {
      if (!intArg(args, 'line').ok) throw new Error('line is required for LINE comments')
      const side = stringArg(args, 'side')
      if (!side.ok || !validReviewCommentSide(side.value)) {
        throw new Error('side must be LEFT or RIGHT for LINE comments')
      }
      const hasStartLine = intArg(args, 'startLine').ok
      const startSide = stringArg(args, 'startSide')
      if (hasStartLine !== startSide.ok) {
        throw new Error('startLine and startSide must be provided together for multi-line comments')
      }
      if (startSide.ok && !validReviewCommentSide(startSide.value)) {
        throw new Error('startSide must be LEFT or RIGHT')
      }
      return
    }
    default:
      throw new Error('subjectType must be FILE or LINE')
  }
}

/** Guard description appended to the `get_file_contents` tool description. */
function appendGetFileContentsGuardDescription(description: string, pr: PullRequest): string {
  const trimmed = description.trim()
  const guard = [
    `dsh-github-reviewer PR review guard: owner/repo must be the current PR base repo (${fullName(pr.base.repo)}) or head repo (${fullName(pr.head.repo)}).`,
    `sha may only be the current base SHA (${pr.base.sha}) or head SHA (${pr.head.sha}).`,
    `ref may only be the matching current PR branch ref (base "${pr.base.ref}" or head "${pr.head.ref}"), refs/heads/<that branch>, refs/pull/${pr.number}/head on the base repo, or one of those SHAs.`,
    'If neither sha nor ref is provided, the guard defaults to the current head SHA.',
  ].join(' ')
  return trimmed === '' ? guard : `${trimmed}\n\n${guard}`
}

/** Patch one JSON Schema properties entry with an enum and description. */
function restrictSchema(
  raw: Record<string, unknown>,
  patches: Record<string, { enumValues?: string[]; description?: string }>,
): Record<string, unknown> {
  const schema = raw
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return schema
  for (const [name, patch] of Object.entries(patches)) {
    const property = (properties as Record<string, unknown>)[name]
    if (typeof property !== 'object' || property === null || Array.isArray(property)) continue
    const record = property as Record<string, unknown>
    if (patch.enumValues !== undefined) record.enum = [...patch.enumValues]
    if (patch.description !== undefined) record.description = patch.description
  }
  return schema
}

function restrictPullRequestReadSchema(raw: Record<string, unknown>): Record<string, unknown> {
  return restrictSchema(raw, {
    method: {
      enumValues: ALLOWED_REVIEW_READ_METHOD_LIST,
      description: 'Pull request read operation allowed by the automated review guard. Comments, commits, review comments, and historical reviews are not allowed.',
    },
  })
}

function restrictReviewWriteSchema(raw: Record<string, unknown>): Record<string, unknown> {
  return restrictSchema(raw, {
    method: {
      enumValues: ['create', 'submit_pending'],
      description: 'Review operation allowed by the automated review guard. Use create without event to create a pending review, then submit_pending with event=COMMENT.',
    },
    event: {
      enumValues: ['COMMENT'],
      description: 'Omit for method=create to create a pending review; set COMMENT only for method=submit_pending.',
    },
  })
}

/** One guarded MCP tool exposed to the model. */
export interface GuardedTool {
  /** Model-facing tool schema (name, description, JSON Schema parameters). */
  spec(): ToolSchema
  /**
   * Validate and execute one tool call against the current PR.
   * @param args - raw JSON arguments from the model.
   * @param signal - per-call cancellation.
   * @returns the bounded result.
   */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<GuardedToolResult>
}

/** Execute a raw MCP tool by remote name. */
export interface McpExecutor {
  call(remoteName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<GuardedToolResult>
}

class GuardedToolImpl implements GuardedTool {
  /**
   * @param inner - raw MCP tool.
   * @param remote - remote tool name without the prefix.
   * @param pr - the PR under review.
   * @param state - shared review guard state.
   * @param executor - raw MCP call bridge.
   * @param logger - guard diagnostics observer.
   */
  constructor(
    readonly inner: RawMcpTool,
    readonly remote: string,
    readonly pr: PullRequest,
    readonly state: ReviewGuardState,
    readonly executor: McpExecutor,
    readonly logger: GuardLogger,
  ) {}

  spec(): ToolSchema {
    switch (this.remote) {
      case 'pull_request_read':
        return {
          name: `${GITHUB_MCP_TOOL_PREFIX}${this.remote}`,
          description: this.inner.description,
          parameters: restrictPullRequestReadSchema(this.inner.inputSchema),
        }
      case 'get_file_contents':
        return {
          name: `${GITHUB_MCP_TOOL_PREFIX}${this.remote}`,
          description: appendGetFileContentsGuardDescription(this.inner.description, this.pr),
          parameters: this.inner.inputSchema,
        }
      case 'pull_request_review_write':
        return {
          name: `${GITHUB_MCP_TOOL_PREFIX}${this.remote}`,
          description: this.inner.description,
          parameters: restrictReviewWriteSchema(this.inner.inputSchema),
        }
      default:
        return {
          name: `${GITHUB_MCP_TOOL_PREFIX}${this.remote}`,
          description: this.inner.description,
          parameters: this.inner.inputSchema,
        }
    }
  }

  async execute(args: Record<string, unknown>, signal: AbortSignal): Promise<GuardedToolResult> {
    try {
      this.validateAndMutate(args)
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true }
    }
    this.recordWriteAttempt(args)
    const result = await this.executor.call(this.remote, args, signal)
    this.recordWriteResult(args, result)
    return result
  }

  private validateAndMutate(args: Record<string, unknown>): void {
    switch (this.remote) {
      case 'pull_request_read':
        validatePullRequestReadArgs(args, this.pr)
        return
      case 'get_file_contents':
        validateFileContentsArgs(args, this.pr)
        return
      case 'pull_request_review_write':
        validateReviewWriteArgs(args, this.pr, this.logger)
        return
      case 'add_comment_to_pending_review':
        validateBasePRArgs(args, this.pr)
        validateReviewCommentArgs(args)
        return
      default:
        throw new Error(`github mcp tool "${this.remote}" is not allowed for automated PR review`)
    }
  }

  private recordWriteAttempt(args: Record<string, unknown>): void {
    switch (this.remote) {
      case 'pull_request_review_write':
        this.state.writeAttempted = true
        if (isCommentSubmit(args)) this.state.submitAttempted = true
        return
      case 'add_comment_to_pending_review':
        this.state.writeAttempted = true
        this.state.inlineCommentsAttempted++
        return
      default:
        return
    }
  }

  private recordWriteResult(args: Record<string, unknown>, result: GuardedToolResult): void {
    switch (this.remote) {
      case 'pull_request_review_write':
        this.recordReviewWriteResult(args, result)
        return
      case 'add_comment_to_pending_review':
        this.recordReviewCommentResult(args, result)
        return
      default:
        return
    }
  }

  private recordReviewWriteResult(args: Record<string, unknown>, result: GuardedToolResult): void {
    const method = stringArg(args, 'method').value
    const body = stringArg(args, 'body').value
    const bodyChars = reviewLogTextChars(body)
    const label = `repo=${fullName(this.pr.base.repo)} number=${this.pr.number} head=${shortSHA(this.pr.head.sha)}`
    switch (method) {
      case 'create': {
        if (result.isError) {
          this.logger.warn(`github pending review create failed ${label} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
          return
        }
        this.state.pendingReviewCreated = true
        this.logger.debug(`github pending review created ${label}`)
        return
      }
      case 'submit_pending': {
        if (result.isError) {
          this.logger.warn(`github pending review submit failed ${label} body_chars=${bodyChars} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
          return
        }
        if (isCommentSubmit(args)) this.state.submittedComment = true
        this.logger.debug(`github pending review submitted ${label} body_chars=${bodyChars}`)
        return
      }
      default:
        return
    }
  }

  private recordReviewCommentResult(args: Record<string, unknown>, result: GuardedToolResult): void {
    const path = stringArg(args, 'path').value
    const subjectType = stringArg(args, 'subjectType').value
    const body = stringArg(args, 'body').value
    const bodyChars = reviewLogTextChars(body)
    const line = intArg(args, 'line')
    const startLine = intArg(args, 'startLine')
    const side = stringArg(args, 'side').value
    const startSide = stringArg(args, 'startSide').value
    const label = `repo=${fullName(this.pr.base.repo)} number=${this.pr.number} head=${shortSHA(this.pr.head.sha)}`
    const position = `path=${path} subject_type=${subjectType} start_line=${startLine.ok ? String(startLine.value) : ''} line=${line.ok ? String(line.value) : ''} start_side=${startSide} side=${side}`
    if (result.isError) {
      this.logger.warn(`github pending review comment failed ${label} ${position} body_chars=${bodyChars} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
      return
    }
    this.state.inlineCommentsAdded++
    this.logger.debug(`github pending review comment added ${label} ${position} body_chars=${bodyChars}`)
  }
}

/**
 * Filter and wrap discovered MCP tools into the guarded review tool set.
 * Non-GitHub tools, disallowed remote names, and duplicates are skipped with
 * a warning.
 * @param tools - tools discovered from the per-review MCP server.
 * @param pr - the PR under review.
 * @param state - shared review guard state.
 * @param executor - raw MCP call bridge.
 * @param logger - guard diagnostics observer.
 * @returns guarded tools; empty when the server exposed no allowed review tools.
 */
export function guardReviewTools(
  tools: RawMcpTool[],
  pr: PullRequest,
  state: ReviewGuardState,
  executor: McpExecutor,
  logger: GuardLogger,
): GuardedTool[] {
  const out: GuardedTool[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    const remote = githubRemoteToolName(tool.name)
    if (remote === undefined) {
      logger.warn(`skipping non-github mcp tool name=${tool.name}`)
      continue
    }
    if (!ALLOWED_REVIEW_REMOTE_TOOLS.has(remote)) {
      logger.warn(`skipping disallowed github mcp tool remote=${remote}`)
      continue
    }
    if (seen.has(remote)) {
      logger.warn(`skipping duplicate guarded github mcp tool name=${tool.name}`)
      continue
    }
    seen.add(remote)
    out.push(new GuardedToolImpl(tool, remote, pr, state, executor, logger))
  }
  return out
}
