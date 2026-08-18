/**
 * Minimal GitHub REST client for the reviewer: open PR listing, trusted file
 * reads, and comment reads/writes. Ported from LingoBridge's client.
 * @module
 */

import type { TokenSource } from './auth.ts'
import type { IssueComment, PullRequest, Repository, ReviewComment, ReviewInstructions } from './model.ts'
import { fullName, repository, shortSHA, truncateForError } from './model.ts'
import { REVIEW_INSTRUCTIONS_PATH } from './prompts.ts'

/** Returned when the GitHub API answers 404. */
export class NotFoundError extends Error {
  /**
   * @param apiPath - API path that was not found.
   * @param body - response body, for diagnostics.
   */
  constructor(
    readonly apiPath: string,
    readonly body: string,
  ) {
    super(`github resource not found: ${apiPath} body=${body}`)
    this.name = 'NotFoundError'
  }
}

/** GitHub API errors that are not 404. */
export class GitHubApiError extends Error {
  /**
   * @param method - HTTP method.
   * @param apiPath - API path.
   * @param status - HTTP status code.
   * @param body - response body, for diagnostics.
   */
  constructor(
    readonly method: string,
    readonly apiPath: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`github api ${method} ${apiPath}: status=${status} body=${body}`)
    this.name = 'GitHubApiError'
  }
}

/** Raw JSON fields shared by raw PR ref objects. */
interface RawPullRequestRef {
  sha?: unknown
  ref?: unknown
  repo?: {
    name?: unknown
    full_name?: unknown
    owner?: { login?: unknown }
  } | null
}

/** Raw pull request JSON as returned by the API. */
interface RawPullRequest {
  number?: unknown
  title?: unknown
  body?: unknown
  html_url?: unknown
  draft?: unknown
  head?: RawPullRequestRef | null
  base?: RawPullRequestRef | null
}

/** Raw issue comment JSON. */
interface RawIssueComment {
  id?: unknown
  body?: unknown
  html_url?: unknown
  created_at?: unknown
  user?: { login?: unknown; type?: unknown } | null
}

/** Raw review comment JSON. */
interface RawReviewComment extends RawIssueComment {
  path?: unknown
  in_reply_to_id?: unknown
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function parseRawRef(raw: RawPullRequestRef | null | undefined): { sha: string; ref: string; repo: Repository } {
  const repoRaw = raw?.repo
  let repo: Repository
  if (repoRaw !== null && repoRaw !== undefined) {
    repo = repository(asString(repoRaw.owner?.login), asString(repoRaw.name))
    if (repo.owner === '' || repo.name === '') {
      const full = asString(repoRaw.full_name)
      const slash = full.indexOf('/')
      repo = slash > 0 && slash < full.length - 1
        ? repository(full.slice(0, slash), full.slice(slash + 1))
        : { owner: '', name: '' }
    }
  } else {
    repo = { owner: '', name: '' }
  }
  return { sha: asString(raw?.sha).trim(), ref: asString(raw?.ref).trim(), repo }
}

function parseRawPullRequest(raw: RawPullRequest): PullRequest {
  return {
    number: asNumber(raw.number),
    title: asString(raw.title),
    body: asString(raw.body),
    htmlUrl: asString(raw.html_url),
    draft: raw.draft === true,
    head: parseRawRef(raw.head),
    base: parseRawRef(raw.base),
  }
}

/** Escape one URL path segment. */
function pathPart(value: string): string {
  return encodeURIComponent(value.trim())
}

/** Escape a file path for the contents endpoint, segment by segment. */
function path(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')
}

/** GitHub REST client bound to one installation token source. */
export class GitHubClient {
  /**
   * @param baseURL - GitHub API base URL.
   * @param tokenSource - installation token source.
   * @param fetchImpl - fetch override for tests.
   */
  constructor(
    readonly baseURL: string,
    private readonly tokenSource: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One JSON request against the GitHub API. */
  private async doJSON<T>(
    method: string,
    apiPath: string,
    query: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.tokenSource.token(signal)
    const url = new URL(this.baseURL + apiPath)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }
    let bodyText: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyText = JSON.stringify(body)
    }
    const response = await this.fetchImpl(url, { method, headers, body: bodyText, signal })
    const text = (await response.text()).slice(0, 8 << 20)
    if (response.status === 404) throw new NotFoundError(apiPath, truncateForError(text))
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(method, apiPath, response.status, truncateForError(text))
    }
    if (text === '') return undefined as T
    return JSON.parse(text) as T
  }

  /**
   * List all open pull requests of a repository, paginated.
   * @param repo - target repository.
   * @param signal - optional cancellation.
   * @returns open PRs in API order.
   */
  async listOpenPullRequests(repo: Repository, signal?: AbortSignal): Promise<PullRequest[]> {
    const out: PullRequest[] = []
    for (let page = 1; ; page++) {
      const raws = await this.doJSON<RawPullRequest[]>(
        'GET',
        `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/pulls`,
        { state: 'open', per_page: '100', page: String(page) },
        undefined,
        signal,
      )
      for (const raw of raws) out.push(parseRawPullRequest(raw))
      if (raws.length < 100) return out
    }
  }

  /**
   * Read the contents of one file from a repository at a ref.
   * @param repo - target repository.
   * @param filePath - repository-relative file path.
   * @param ref - branch name or SHA.
   * @param signal - optional cancellation.
   * @returns decoded file text.
   */
  async getFileContents(repo: Repository, filePath: string, ref: string, signal?: AbortSignal): Promise<string> {
    const query: Record<string, string> = {}
    if (ref.trim() !== '') query.ref = ref.trim()
    const out = await this.doJSON<{ type?: unknown; encoding?: unknown; content?: unknown }>(
      'GET',
      `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/contents/${path(filePath)}`,
      query,
      undefined,
      signal,
    )
    const type = asString(out.type)
    if (type !== '' && type !== 'file') {
      throw new Error(`github contents path ${filePath} is ${type}, not file`)
    }
    if (out.encoding === 'base64') {
      return Buffer.from(asString(out.content).replaceAll('\n', ''), 'base64').toString('utf8')
    }
    return asString(out.content)
  }

  /**
   * Read trusted review instructions for a PR: the base repo file at the base
   * branch first, then at the exact base SHA. Head-branch files are never
   * consulted.
   * @param pr - the pull request.
   * @param signal - optional cancellation.
   * @returns instructions when found.
   */
  async reviewInstructions(pr: PullRequest, signal?: AbortSignal): Promise<{ instructions?: ReviewInstructions; ok: boolean }> {
    if (pr.base.ref !== '') {
      try {
        const text = await this.getFileContents(pr.base.repo, REVIEW_INSTRUCTIONS_PATH, pr.base.ref, signal)
        return {
          instructions: { text, source: `${fullName(pr.base.repo)}@${pr.base.ref}:${REVIEW_INSTRUCTIONS_PATH}` },
          ok: true,
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error
      }
    }
    try {
      const text = await this.getFileContents(pr.base.repo, REVIEW_INSTRUCTIONS_PATH, pr.base.sha, signal)
      return {
        instructions: { text, source: `${fullName(pr.base.repo)}@${shortSHA(pr.base.sha)}:${REVIEW_INSTRUCTIONS_PATH}` },
        ok: true,
      }
    } catch (error) {
      if (error instanceof NotFoundError) return { ok: false }
      throw error
    }
  }

  /**
   * List issue-level PR comments created since an instant, paginated.
   * @param repo - target repository.
   * @param prNumber - pull request number.
   * @param since - lower time bound, optional.
   * @param signal - optional cancellation.
   * @returns comments in API order.
   */
  async listIssueComments(repo: Repository, prNumber: number, since: Date | undefined, signal?: AbortSignal): Promise<IssueComment[]> {
    const out: IssueComment[] = []
    for (let page = 1; ; page++) {
      const query: Record<string, string> = { per_page: '100', page: String(page) }
      if (since !== undefined) query.since = since.toISOString()
      const raws = await this.doJSON<RawIssueComment[]>(
        'GET',
        `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/issues/${prNumber}/comments`,
        query,
        undefined,
        signal,
      )
      for (const raw of raws) {
        out.push({
          id: asNumber(raw.id),
          body: asString(raw.body),
          user: { login: asString(raw.user?.login), type: asString(raw.user?.type) },
          createdAt: new Date(asString(raw.created_at)),
          htmlUrl: asString(raw.html_url),
        })
      }
      if (raws.length < 100) return out
    }
  }

  /**
   * List review-thread comments created since an instant, paginated.
   * @param repo - target repository.
   * @param prNumber - pull request number.
   * @param since - lower time bound, optional.
   * @param signal - optional cancellation.
   * @returns comments in creation order.
   */
  async listReviewComments(repo: Repository, prNumber: number, since: Date | undefined, signal?: AbortSignal): Promise<ReviewComment[]> {
    const out: ReviewComment[] = []
    for (let page = 1; ; page++) {
      const query: Record<string, string> = {
        sort: 'created',
        direction: 'asc',
        per_page: '100',
        page: String(page),
      }
      if (since !== undefined) query.since = since.toISOString()
      const raws = await this.doJSON<RawReviewComment[]>(
        'GET',
        `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/pulls/${prNumber}/comments`,
        query,
        undefined,
        signal,
      )
      for (const raw of raws) {
        out.push({
          id: asNumber(raw.id),
          body: asString(raw.body),
          user: { login: asString(raw.user?.login), type: asString(raw.user?.type) },
          createdAt: new Date(asString(raw.created_at)),
          htmlUrl: asString(raw.html_url),
          path: asString(raw.path),
          inReplyTo: asNumber(raw.in_reply_to_id),
        })
      }
      if (raws.length < 100) return out
    }
  }

  /**
   * Post an issue-level comment on a PR.
   * @param repo - target repository.
   * @param prNumber - pull request number.
   * @param body - comment text.
   * @param signal - optional cancellation.
   */
  async createIssueComment(repo: Repository, prNumber: number, body: string, signal?: AbortSignal): Promise<void> {
    await this.doJSON<unknown>(
      'POST',
      `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/issues/${prNumber}/comments`,
      {},
      { body },
      signal,
    )
  }

  /**
   * Reply to a review-thread comment.
   * @param repo - target repository.
   * @param prNumber - pull request number.
   * @param commentId - the review comment to reply to.
   * @param body - reply text.
   * @param signal - optional cancellation.
   */
  async createReviewCommentReply(repo: Repository, prNumber: number, commentId: number, body: string, signal?: AbortSignal): Promise<void> {
    await this.doJSON<unknown>(
      'POST',
      `/repos/${pathPart(repo.owner)}/${pathPart(repo.name)}/pulls/${prNumber}/comments/${commentId}/replies`,
      {},
      { body },
      signal,
    )
  }
}
