import { describe, expect, it, vi } from 'vitest'
import { GitHubApiError, GitHubClient, GitHubRateLimitError, NotFoundError } from '../src/github/client.ts'
import type { PullRequest } from '../src/github/model.ts'

const repo = { owner: 'owner', name: 'repo' }

function client(fetchImpl: typeof fetch): GitHubClient {
  return new GitHubClient('https://api.github.com', { token: async () => 'tok' }, fetchImpl)
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Fix bug',
    body: 'body',
    html_url: 'https://github.com/owner/repo/pull/42',
    draft: false,
    changed_files: 3,
    additions: 10,
    deletions: 2,
    head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo', full_name: 'forker/repo' } },
    base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo', full_name: 'owner/repo' } },
    ...overrides,
  }
}

describe('GitHubClient.listAccessibleRepositories', () => {
  const payload = (owner: string, repository: string, isPrivate = false) => ({
    owner: { login: owner },
    name: repository,
    full_name: `${owner}/${repository}`,
    private: isPrivate,
  })

  it('lists PAT repositories with affiliation pagination, validation, deduplication, and sorting', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = new URL(String(url))
      expect(value.pathname).toBe('/user/repos')
      expect(value.searchParams.get('affiliation')).toBe('owner,collaborator,organization_member')
      const page = value.searchParams.get('page')
      const repositories = page === '1'
        ? [payload('Zoo', 'beta', true), ...Array.from({ length: 99 }, (_, index) => payload('fill', `repo-${index}`))]
        : [payload('alpha', 'One'), payload('zoo', 'BETA'), { owner: { login: '' }, name: 'invalid', full_name: '/invalid' }]
      return new Response(JSON.stringify(repositories), { status: 200 })
    })

    const repositories = await client(fetchImpl as typeof fetch).listAccessibleRepositories('user')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(repositories).toHaveLength(101)
    expect(repositories[0]).toEqual({ owner: 'alpha', repository: 'One', fullName: 'alpha/One', private: false })
    expect(repositories.at(-1)).toEqual({ owner: 'zoo', repository: 'BETA', fullName: 'zoo/BETA', private: false })
  })

  it('lists GitHub App installation repositories from the response envelope', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = new URL(String(url))
      expect(value.pathname).toBe('/installation/repositories')
      expect(value.searchParams.get('affiliation')).toBeNull()
      expect(init).toBeDefined()
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok')
      return new Response(JSON.stringify({ repositories: [payload('owner', 'private-repo', true)] }), { status: 200 })
    })

    await expect(client(fetchImpl as typeof fetch).listAccessibleRepositories('installation')).resolves.toEqual([
      { owner: 'owner', repository: 'private-repo', fullName: 'owner/private-repo', private: true },
    ])
  })

  it('accepts an exact full-page safety cap when the lookahead page is empty', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get('page'))
      const repositories = page <= 50
        ? Array.from({ length: 100 }, (_, index) => payload('owner', `repo-${page}-${index}`))
        : []
      return new Response(JSON.stringify(repositories), { status: 200 })
    })

    await expect(client(fetchImpl as typeof fetch).listAccessibleRepositories('user'))
      .resolves.toHaveLength(5_000)
    expect(fetchImpl).toHaveBeenCalledTimes(51)
  })

  it('rejects an invalid listing envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ repositories: null }), { status: 200 }))
    await expect(client(fetchImpl as typeof fetch).listAccessibleRepositories('installation'))
      .rejects.toThrow('invalid repository listing response')
  })
})

describe('GitHubClient.listOpenPullRequests', () => {
  it('paginates and parses PRs', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const page = new URL(String(url)).searchParams.get('page')
      const prs = page === '1' ? Array.from({ length: 100 }, (_, index) => prPayload({ number: index + 1 })) : [prPayload({ number: 101 })]
      return new Response(JSON.stringify(prs), { status: 200 })
    })
    const prs = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo)
    expect(prs).toHaveLength(101)
    expect(prs[0]).toMatchObject({
      number: 1,
      title: 'Fix bug',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo' } },
      base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo' } },
    })
    expect(prs[100].number).toBe(101)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('marks draft PRs', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([prPayload({ draft: true })]), { status: 200 }))
    const prs = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo)
    expect(prs[0].draft).toBe(true)
  })

  it('throws on non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }))
    await expect(client(fetchImpl as typeof fetch).listOpenPullRequests(repo)).rejects.toThrow('status=429')
  })
})

describe('GitHubClient.reviewInstructions', () => {
  it('prefers the base ref when it exists and never consults the base SHA', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url))
      if (u.searchParams.get('ref') === 'main') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('trusted-by-ref\n').toString('base64') }), { status: 200 })
      }
      throw new Error('the base SHA path must not be requested when the base ref read succeeds')
    })
    const pr = prPayload() as unknown as PullRequest
    const outcome = await client(fetchImpl as typeof fetch).reviewInstructions(pr)
    expect(outcome.ok).toBe(true)
    expect(outcome.instructions?.text).toBe('trusted-by-ref\n')
    expect(outcome.instructions?.source).toBe('owner/repo@main:.github/review_instructions.md')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the base SHA when the base ref read 404s', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url))
      if (u.searchParams.get('ref') === 'main') return new Response('', { status: 404 })
      if (u.searchParams.get('ref') === 'base-sha') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('trusted\n').toString('base64') }), { status: 200 })
      }
      return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('by-ref').toString('base64') }), { status: 200 })
    })
    const pr = prPayload() as unknown as PullRequest
    const outcome = await client(fetchImpl as typeof fetch).reviewInstructions(pr)
    expect(outcome.ok).toBe(true)
    expect(outcome.instructions?.text).toBe('trusted\n')
    expect(outcome.instructions?.source).toBe('owner/repo@base-sha:.github/review_instructions.md')
  })

  it('returns not-ok when the file is missing at both refs', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const pr = prPayload() as unknown as PullRequest
    const outcome = await client(fetchImpl as typeof fetch).reviewInstructions(pr)
    expect(outcome.ok).toBe(false)
  })

  it('throws NotFoundError for 404 file reads', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }))
    await expect(client(fetchImpl as typeof fetch).getFileContents(repo, 'a.md', 'main')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects contents paths that are not files', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'dir', encoding: 'base64', content: '' }), { status: 200 }))
    await expect(client(fetchImpl as typeof fetch).getFileContents(repo, 'a.md', 'main')).rejects.toThrow('not file')
  })

  it('propagates non-404 instruction read failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const pr = prPayload() as unknown as PullRequest
    await expect(client(fetchImpl as typeof fetch).reviewInstructions(pr)).rejects.toThrow('status=500')
  })

  it('throws GitHubApiError when the base-ref read fails with a 500 instead of falling back to the SHA', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url))
      if (u.searchParams.get('ref') === 'main') return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('unreachable').toString('base64') }), { status: 200 })
    })
    const pr = prPayload() as unknown as PullRequest
    const error = await client(fetchImpl as typeof fetch).reviewInstructions(pr).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect((error as GitHubApiError).status).toBe(500)
    expect(String(error)).toContain('status=500')
  })
})

describe('GitHubClient comments', () => {
  it('lists issue and review comments with since and skips pagination when short', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url))
      if (u.pathname.includes('/issues/42/comments')) {
        return new Response(JSON.stringify([
          { id: 1, body: '/bot hi', html_url: 'u', created_at: '2026-01-01T00:00:00Z', user: { login: 'alice', type: 'User' } },
        ]), { status: 200 })
      }
      return new Response(JSON.stringify([
        { id: 2, body: 'thread', html_url: 'u', path: 'a.ts', created_at: '2026-01-01T01:00:00Z', in_reply_to_id: 0, user: { login: 'bob', type: 'User' } },
      ]), { status: 200 })
    })
    const c = client(fetchImpl as typeof fetch)
    const issue = await c.listIssueComments(repo, 42, new Date('2025-12-31T00:00:00Z'))
    expect(issue).toHaveLength(1)
    expect(issue[0].body).toBe('/bot hi')
    const review = await c.listReviewComments(repo, 42, new Date('2025-12-31T00:00:00Z'))
    expect(review).toHaveLength(1)
    expect(review[0].path).toBe('a.ts')
  })

  it('parses the author association of issue comments', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { id: 1, body: '/bot hi', html_url: 'u', created_at: '2026-01-01T00:00:00Z', author_association: 'OWNER', user: { login: 'alice', type: 'User' } },
    ]), { status: 200 }))
    const issue = await client(fetchImpl as typeof fetch).listIssueComments(repo, 42)
    expect(issue).toHaveLength(1)
    expect(issue[0].authorAssociation).toBe('OWNER')
    expect(issue[0].user.login).toBe('alice')
  })

  it('parses the author association of review comments', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { id: 2, body: 'thread', html_url: 'u', path: 'a.ts', created_at: '2026-01-01T01:00:00Z', in_reply_to_id: 0, author_association: 'CONTRIBUTOR', user: { login: 'bob', type: 'User' } },
    ]), { status: 200 }))
    const review = await client(fetchImpl as typeof fetch).listReviewComments(repo, 42)
    expect(review[0].authorAssociation).toBe('CONTRIBUTOR')
  })

  it('posts issue comments and review comment replies', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response('', { status: 201 }))
    const c = client(fetchImpl as typeof fetch)
    await c.createIssueComment(repo, 42, 'hello')
    await c.createReviewCommentReply(repo, 42, 7, 'reply')
    const urls = fetchImpl.mock.calls.map(call => String(call[0]))
    expect(urls[0]).toContain('/issues/42/comments')
    expect(urls[1]).toContain('/pulls/42/comments/7/replies')
  })
})

describe('GitHubClient error handling', () => {
  it('throws GitHubRateLimitError with retryAfterSeconds from the retry-after header on 429', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }))
    const error = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).status).toBe(429)
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBe(30)
  })

  it('throws GitHubRateLimitError for 403 with an exhausted rate-limit budget', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    const error = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).status).toBe(403)
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBeUndefined()
  })

  it('keeps 403 with a remaining budget a plain GitHubApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403, headers: { 'x-ratelimit-remaining': '5' } }))
    const error = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).not.toBeInstanceOf(GitHubRateLimitError)
  })

  it('wraps unparseable JSON responses in GitHubApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    const error = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(String(error)).toContain('invalid JSON response')
  })

  it('caps pagination at 50 pages', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => prPayload({ number: index + 1 }))), { status: 200 }))
    const error = await client(fetchImpl as typeof fetch).listOpenPullRequests(repo).then(() => null, (caught: unknown) => caught)
    expect(String(error)).toContain('exceeded 50 pages')
    expect(fetchImpl).toHaveBeenCalledTimes(50)
  })
})
