import { describe, expect, it, vi } from 'vitest'
import { GitHubClient, NotFoundError } from '../src/github/client.ts'
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
    head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo', full_name: 'forker/repo' } },
    base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo', full_name: 'owner/repo' } },
    ...overrides,
  }
}

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
  it('prefers the base ref, then the base SHA', async () => {
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
