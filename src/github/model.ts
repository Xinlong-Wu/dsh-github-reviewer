/**
 * Shared GitHub domain types for the reviewer plugin.
 * These are detached values built from GitHub REST responses; nothing here
 * holds live HTTP or MCP state.
 * @module
 */

/** A GitHub repository identity in `owner/repo` form. */
export interface Repository {
  owner: string
  name: string
}

/** One side (base or head) of a pull request. */
export interface PullRequestRef {
  /** Full commit SHA. */
  sha: string
  /** Branch or ref name. */
  ref: string
  /** Repository the ref lives in. */
  repo: Repository
}

/** The subset of a pull request the reviewer operates on. */
export interface PullRequest {
  number: number
  title: string
  body: string
  htmlUrl: string
  draft: boolean
  head: PullRequestRef
  base: PullRequestRef
}

/** Trusted review instructions and where they came from. */
export interface ReviewInstructions {
  /** Instruction text, never from the PR head branch. */
  text: string
  /** Human-readable provenance string for logs and the system prompt. */
  source: string
}

/** The user who authored a comment. */
export interface CommentUser {
  login: string
  /** GitHub user type: `User`, `Bot`, or `Organization`. */
  type: string
}

/** An issue-level PR comment. */
export interface IssueComment {
  id: number
  body: string
  user: CommentUser
  /** GitHub `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, etc. */
  authorAssociation: string
  createdAt: Date
  htmlUrl: string
}

/** A review-thread comment on a PR. */
export interface ReviewComment {
  id: number
  body: string
  user: CommentUser
  /** GitHub `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, etc. */
  authorAssociation: string
  createdAt: Date
  htmlUrl: string
  path: string
  /** Non-zero when this comment is itself a reply to another review comment. */
  inReplyTo: number
}

/**
 * Normalize a repository identity from two strings.
 * @param owner - repository owner login.
 * @param name - repository name.
 * @returns the typed repository.
 */
export function repository(owner: string, name: string): Repository {
  return { owner: owner.trim(), name: name.trim() }
}

/** Case-insensitive repository equality. */
export function sameRepo(left: Repository, right: Repository): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.name.toLowerCase() === right.name.toLowerCase()
}

/** `owner/repo` display form, or the empty string when either half is missing. */
export function fullName(repo: Repository): string {
  if (repo.owner === '' || repo.name === '') return ''
  return `${repo.owner}/${repo.name}`
}

/**
 * Parse an `owner/repo` string.
 * @param value - raw repository string.
 * @returns the parsed repository, or undefined when it is not exactly `owner/repo`.
 */
export function parseRepository(value: string): Repository | undefined {
  const trimmed = value.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.includes('/', slash + 1)) return undefined
  const owner = trimmed.slice(0, slash).trim()
  const name = trimmed.slice(slash + 1).trim()
  if (owner === '' || name === '') return undefined
  return { owner, name }
}

/** First 12 characters of a SHA, for log lines. */
export function shortSHA(sha: string): string {
  const trimmed = sha.trim()
  return trimmed.length <= 12 ? trimmed : trimmed.slice(0, 12)
}

/** Truncate an error-body string for diagnostics. */
export function truncateForError(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 512) return trimmed
  return `${trimmed.slice(0, 512)}...[truncated]`
}
