/**
 * PR-review tool guard: wraps the GitHub MCP tools exposed to the review
 * agent as harness `ToolDefinition`s so every call must target the current
 * PR, reads are limited to allowed methods and refs, and writes are limited
 * to the COMMENT pending-review workflow. The validation and write-tracking
 * state are shared with LingoBridge's `guardReviewTools`; the execution
 * bridge is the harness tool pipeline (`execute(args, exec)`).
 * @module
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { McpHost, RawMcpTool } from './mcp-host.ts'
import type { PullRequest, Repository, ReviewInstructions } from './model.ts'
import { fullName, sameRepo, shortSHA } from './model.ts'
import { redactSecrets } from './sanitizer.ts'

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

/** Write tools unavailable while the turn is a `/bot` chat flow. */
const CHAT_FORBIDDEN_WRITE_TOOLS = new Set(['pull_request_review_write', 'add_comment_to_pending_review'])

/** The keys a `submit_pending` call may carry after normalization. */
const REVIEW_SUBMIT_ALLOWED_KEYS = new Set(['owner', 'repo', 'pullNumber', 'method', 'event', 'body'])

/** Cap for changed-file pagination when scoping base-side file reads. */
const CHANGED_FILES_MAX_PAGES = 50

/**
 * Write-tracking state for one review turn. The caller reads
 * {@link submittedComment} to decide whether the cursor may be marked
 * reviewed, and {@link toolCallsExecuted} to enforce the tool-call budget.
 */
export class ReviewGuardState {
  submittedComment = false
  writeAttempted = false
  pendingReviewCreated = false
  inlineCommentsAttempted = 0
  inlineCommentsAdded = 0
  submitAttempted = false
  toolCallsExecuted = 0
  /** Lazily fetched set of files changed by the PR; scopes base-side file reads. */
  changedFiles?: Set<string>
  /** True when the changed-file list could not be fetched (base-side reads fail closed). */
  changedFilesFailed = false
}

/**
 * The per-turn context the guarded tools read at execution time: the PR under
 * review, the shared write-tracking state, the live MCP host, and the current
 * flow's trusted instructions. Set by the agent runner before each turn and
 * cleared afterwards.
 */
export interface TurnSlot {
  current?: {
    pr: PullRequest
    flow: 'review' | 'chat'
    state: ReviewGuardState
    instructions?: ReviewInstructions
    host: McpHost
  }
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

/** Strip control and format characters from a model-controlled value before it enters a log line. */
function logSafe(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '')
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
  args.ref = undefined
}

/**
 * Whether a validated `get_file_contents` call reads base-side content (the
 * base branch or base SHA on the base repository). Base-side content may
 * contain secrets the PR author cannot otherwise read; head-side content is
 * the PR author's own and carries no exfiltration risk.
 */
function isBaseSideContent(args: Record<string, unknown>, pr: PullRequest): boolean {
  const target = { owner: stringArg(args, 'owner').value, name: stringArg(args, 'repo').value }
  if (!sameRepo(target, pr.base.repo)) return false
  const sha = stringArg(args, 'sha')
  if (sha.ok) return sha.value === pr.base.sha.trim()
  const ref = stringArg(args, 'ref')
  if (ref.ok) return branchRefMatches(ref.value, pr.base.ref)
  return false
}

/**
 * Fetch (once per turn) the set of paths changed by the PR, used to scope
 * base-side file reads. Fails closed: when the list cannot be fetched, the
 * state records the failure and base-side reads are rejected.
 */
async function ensureChangedFiles(turn: NonNullable<TurnSlot['current']>, logger: GuardLogger): Promise<Set<string>> {
  if (turn.state.changedFiles !== undefined) return turn.state.changedFiles
  if (turn.state.changedFilesFailed) {
    throw new Error('get_file_contents on base-side content requires the PR changed-file list, which failed to load')
  }
  const files = new Set<string>()
  try {
    for (let page = 1; page <= CHANGED_FILES_MAX_PAGES; page++) {
      const result = await turn.host.call('pull_request_read', {
        owner: turn.pr.base.repo.owner,
        repo: turn.pr.base.repo.name,
        pullNumber: turn.pr.number,
        method: 'get_files',
        perPage: 100,
        page,
      }, AbortSignal.timeout(30_000))
      if (result.isError) throw new Error(`get_files failed: ${summarizeReviewLogText(result.content, 200)}`)
      const parsed: unknown = JSON.parse(result.content)
      if (!Array.isArray(parsed)) throw new Error('get_files returned a non-array payload')
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as { filename?: unknown; previous_filename?: unknown }
        if (typeof record.filename === 'string' && record.filename !== '') files.add(record.filename)
        if (typeof record.previous_filename === 'string' && record.previous_filename !== '') files.add(record.previous_filename)
      }
      if (parsed.length < 100) break
    }
  } catch (error) {
    turn.state.changedFilesFailed = true
    logger.warn(`github review changed-file list unavailable repo=${fullName(turn.pr.base.repo)} number=${turn.pr.number}: ${String(error)}`)
    throw new Error('get_file_contents on base-side content requires the PR changed-file list, which failed to load')
  }
  turn.state.changedFiles = files
  logger.debug(`github review changed-file list loaded repo=${fullName(turn.pr.base.repo)} number=${turn.pr.number} files=${files.size}`)
  return files
}

/**
 * Scope base-side file reads to the paths changed by the PR: reading
 * base-branch secrets through prompt injection is the reviewer's main
 * confused-deputy risk, so base-side content is only served for files the PR
 * actually touches. Head-side content is unrestricted.
 */
async function assertFileReadScope(args: Record<string, unknown>, turn: NonNullable<TurnSlot['current']>, logger: GuardLogger): Promise<void> {
  if (!isBaseSideContent(args, turn.pr)) return
  const path = stringArg(args, 'path')
  if (!path.ok) throw new Error('get_file_contents on base-side content requires an explicit path')
  const normalized = path.value.replace(/^\.\//, '')
  const changed = await ensureChangedFiles(turn, logger)
  if (!changed.has(normalized)) {
    throw new Error('get_file_contents on base-side content is limited to files changed by the current PR')
  }
}

/** The keys a pending-review `create` call may carry after normalization. */
const REVIEW_CREATE_ALLOWED_KEYS = new Set(['owner', 'repo', 'pullNumber', 'method', 'commitID'])

/**
 * Normalize a pending-review `create` call: drop `event`/`body` and every
 * other key the workflow forbids, and return the cleaned payload.
 * @param args - validated raw arguments.
 * @param pr - the PR under review.
 * @param logger - guard diagnostics observer.
 * @returns the sanitized create payload.
 */
function normalizeReviewCreateArgs(args: Record<string, unknown>, pr: PullRequest, logger: GuardLogger): Record<string, unknown> {
  const hadEvent = args.event !== undefined
  const body = stringArg(args, 'body')
  const hadRawBody = args.body !== undefined
  const bodyChars = reviewLogTextChars(body.value)

  const cleaned: Record<string, unknown> = {}
  for (const key of Object.keys(args)) {
    if (REVIEW_CREATE_ALLOWED_KEYS.has(key)) cleaned[key] = args[key]
  }

  const expectedCommitID = pr.head.sha.trim()
  const commitID = stringArg(cleaned, 'commitID')
  if (commitID.ok && commitID.value.trim() !== expectedCommitID) {
    throw new Error('pull_request_review_write commitID must be current PR head SHA')
  }
  const injectedCommitID = !commitID.ok
  if (injectedCommitID) cleaned.commitID = expectedCommitID
  const droppedExtraArgs = Object.keys(args).length - Object.keys(cleaned).length
  if (hadEvent || hadRawBody || injectedCommitID || droppedExtraArgs > 0) {
    logger.warn(
      `normalized create review repo=${fullName(pr.base.repo)} number=${pr.number} head=${shortSHA(pr.head.sha)}`
      + ` dropped_event=${hadEvent} dropped_body=${hadRawBody} dropped_extra_args=${droppedExtraArgs}`
      + ` injected_commit_id=${injectedCommitID} body_chars=${bodyChars}`,
    )
  }
  return cleaned
}

function validateReviewWriteArgs(args: Record<string, unknown>, pr: PullRequest, logger: GuardLogger): Record<string, unknown> {
  validateBasePRArgs(args, pr)
  const method = stringArg(args, 'method')
  if (!method.ok) throw new Error('method is required')
  switch (method.value) {
    case 'create':
      return normalizeReviewCreateArgs(args, pr, logger)
    case 'submit_pending': {
      const event = stringArg(args, 'event')
      if (!event.ok || event.value !== 'COMMENT') {
        throw new Error('pull_request_review_write submit_pending is only allowed with event=COMMENT')
      }
      const cleaned: Record<string, unknown> = {}
      for (const key of Object.keys(args)) {
        if (REVIEW_SUBMIT_ALLOWED_KEYS.has(key)) cleaned[key] = args[key]
      }
      const dropped = Object.keys(args).length - Object.keys(cleaned).length
      if (dropped > 0) {
        logger.warn(
          `normalized submit_pending repo=${fullName(pr.base.repo)} number=${pr.number} dropped_extra_args=${dropped}`,
        )
      }
      const body = stringArg(cleaned, 'body')
      if (body.ok) cleaned.body = redactSecrets(body.value)
      return cleaned
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
  // Redact secret-looking strings before model-written text leaves as a comment.
  args.body = redactSecrets(body.value)
  const subjectType = stringArg(args, 'subjectType')
  if (!subjectType.ok) throw new Error('subjectType is required')
  switch (subjectType.value) {
    case 'FILE': {
      if (intArg(args, 'startLine').ok) throw new Error('startLine is only allowed for LINE comments')
      if (stringArg(args, 'startSide').ok) throw new Error('startSide is only allowed for LINE comments')
      return
    }
    case 'LINE': {
      const line = intArg(args, 'line')
      if (!line.ok) throw new Error('line is required for LINE comments')
      if (line.value < 1) throw new Error('line must be a positive integer')
      const side = stringArg(args, 'side')
      if (!side.ok || !validReviewCommentSide(side.value)) {
        throw new Error('side must be LEFT or RIGHT for LINE comments')
      }
      const startLine = intArg(args, 'startLine')
      const startSide = stringArg(args, 'startSide')
      if (startLine.ok !== startSide.ok) {
        throw new Error('startLine and startSide must be provided together for multi-line comments')
      }
      if (startLine.ok) {
        if (startLine.value < 1 || startLine.value > line.value) {
          throw new Error('startLine must be a positive integer not greater than line')
        }
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
    'Reads of base-side content (base branch or base SHA on the base repo) are limited to files changed by this PR; head-side content is unrestricted.',
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

/** The canonical value one guarded tool returns; `render` extracts its text. */
interface GuardedToolValue {
  content: Array<{ type: 'text'; text: string }>
}

/** Model-facing content projection of the canonical value. */
function renderGuardedValue(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const content = (value as Partial<GuardedToolValue> | null | undefined)?.content ?? []
  const text = content.map(block => block.text ?? '').join('')
  return [{ type: 'text', text }]
}

/** One guarded tool built from a discovered MCP tool. */
function buildGuardedTool(
  inner: RawMcpTool,
  pr: PullRequest,
  slot: TurnSlot,
  limits: { maxToolCalls: number; toolTimeoutMs: number },
  logger: GuardLogger,
): ToolDefinition {
  const remote = githubRemoteToolName(inner.name)
  if (remote === undefined || !ALLOWED_REVIEW_REMOTE_TOOLS.has(remote)) {
    throw new Error(`raw tool "${inner.name}" is not a guardable github tool`)
  }
  const parameters = (() => {
    switch (remote) {
      case 'pull_request_read':
        return restrictPullRequestReadSchema(inner.inputSchema)
      case 'pull_request_review_write':
        return restrictReviewWriteSchema(inner.inputSchema)
      default:
        return inner.inputSchema
    }
  })()
  const description = remote === 'get_file_contents'
    ? appendGetFileContentsGuardDescription(inner.description, pr)
    : inner.description

  const definition: ToolDefinition = {
    name: `${GITHUB_MCP_TOOL_PREFIX}${remote}`,
    description,
    parameters,
    timeoutMs: limits.toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render: renderGuardedValue,
    },
    async execute(args, exec): Promise<GuardedToolValue> {
      const turn = slot.current
      if (turn === undefined) throw new Error('github reviewer turn is not active')
      if (turn.flow === 'chat' && CHAT_FORBIDDEN_WRITE_TOOLS.has(remote)) {
        throw new Error('github review write tools are not available during /bot chat turns')
      }
      const parsed = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const sanitized = validateAndMutate(remote, parsed, turn.pr, logger)
      if (remote === 'get_file_contents') await assertFileReadScope(sanitized, turn, logger)
      if (turn.state.toolCallsExecuted >= limits.maxToolCalls) {
        throw new Error(`github review hit the max_tool_calls limit (${limits.maxToolCalls})`)
      }
      turn.state.toolCallsExecuted++
      recordWriteAttempt(remote, sanitized, turn.state)
      const callSignal = AbortSignal.any([exec.signal, AbortSignal.timeout(limits.toolTimeoutMs)])
      const result = await turn.host.call(remote, sanitized, callSignal)
      recordWriteResult(remote, sanitized, result, turn, logger)
      if (result.isError) throw new Error(result.content)
      return { content: [{ type: 'text', text: result.content }] }
    },
  }
  return definition
}

function validateAndMutate(remote: string, args: Record<string, unknown>, pr: PullRequest, logger: GuardLogger): Record<string, unknown> {
  switch (remote) {
    case 'pull_request_read':
      validatePullRequestReadArgs(args, pr)
      return args
    case 'get_file_contents':
      validateFileContentsArgs(args, pr)
      return args
    case 'pull_request_review_write':
      return validateReviewWriteArgs(args, pr, logger)
    case 'add_comment_to_pending_review':
      validateBasePRArgs(args, pr)
      validateReviewCommentArgs(args)
      return args
    default:
      throw new Error(`github mcp tool "${remote}" is not allowed for automated PR review`)
  }
}

function recordWriteAttempt(remote: string, args: Record<string, unknown>, state: ReviewGuardState): void {
  switch (remote) {
    case 'pull_request_review_write':
      state.writeAttempted = true
      if (isCommentSubmit(args)) state.submitAttempted = true
      return
    case 'add_comment_to_pending_review':
      state.writeAttempted = true
      state.inlineCommentsAttempted++
      return
    default:
      return
  }
}

function recordWriteResult(
  remote: string,
  args: Record<string, unknown>,
  result: { content: string; isError: boolean },
  turn: NonNullable<TurnSlot['current']>,
  logger: GuardLogger,
): void {
  switch (remote) {
    case 'pull_request_review_write': {
      const method = stringArg(args, 'method').value
      const body = stringArg(args, 'body').value
      const bodyChars = reviewLogTextChars(body)
      const label = `repo=${fullName(turn.pr.base.repo)} number=${turn.pr.number} head=${shortSHA(turn.pr.head.sha)}`
      if (method === 'create') {
        if (result.isError) {
          logger.warn(`github pending review create failed ${label} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
          return
        }
        turn.state.pendingReviewCreated = true
        logger.debug(`github pending review created ${label}`)
        return
      }
      if (method === 'submit_pending') {
        if (result.isError) {
          logger.warn(`github pending review submit failed ${label} body_chars=${bodyChars} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
          return
        }
        if (isCommentSubmit(args)) turn.state.submittedComment = true
        logger.debug(`github pending review submitted ${label} body_chars=${bodyChars}`)
        return
      }
      return
    }
    case 'add_comment_to_pending_review': {
      const path = stringArg(args, 'path').value
      const subjectType = stringArg(args, 'subjectType').value
      const body = stringArg(args, 'body').value
      const bodyChars = reviewLogTextChars(body)
      const line = intArg(args, 'line')
      const startLine = intArg(args, 'startLine')
      const side = stringArg(args, 'side').value
      const startSide = stringArg(args, 'startSide').value
      const label = `repo=${fullName(turn.pr.base.repo)} number=${turn.pr.number} head=${shortSHA(turn.pr.head.sha)}`
      const position = `path=${logSafe(path)} subject_type=${subjectType} start_line=${startLine.ok ? String(startLine.value) : ''} line=${line.ok ? String(line.value) : ''} start_side=${logSafe(startSide)} side=${logSafe(side)}`
      if (result.isError) {
        logger.warn(`github pending review comment failed ${label} ${position} body_chars=${bodyChars} error=${summarizeReviewLogText(result.content, REVIEW_LOG_TEXT_LIMIT)}`)
        return
      }
      turn.state.inlineCommentsAdded++
      logger.debug(`github pending review comment added ${label} ${position} body_chars=${bodyChars}`)
      return
    }
    default:
      return
  }
}

/**
 * Filter and wrap discovered MCP tools into harness tool definitions bound to
 * the shared turn slot. Non-GitHub tools, disallowed remote names, and
 * duplicates are skipped with a warning.
 * @param tools - tools discovered from the per-review MCP server.
 * @param pr - the PR under review.
 * @param slot - the mutable per-turn context read at execution time.
 * @param limits - tool-call budget and per-call timeout.
 * @param logger - guard diagnostics observer.
 * @returns guarded tool definitions; empty when the server exposed no allowed review tools.
 */
export function buildGuardedToolDefinitions(
  tools: RawMcpTool[],
  pr: PullRequest,
  slot: TurnSlot,
  limits: { maxToolCalls: number; toolTimeoutMs: number },
  logger: GuardLogger,
): ToolDefinition[] {
  const out: ToolDefinition[] = []
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
    out.push(buildGuardedTool(tool, pr, slot, limits, logger))
  }
  return out
}
