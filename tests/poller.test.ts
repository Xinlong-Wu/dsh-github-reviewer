import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedAccountConfig } from '../src/config.ts'
import type { GitHubClient } from '../src/github/client.ts'
import type { PullRequest } from '../src/github/model.ts'
import { AccountPoller, recordingLogger } from '../src/poller.ts'
import type { ReviewDriver } from '../src/poller.ts'
import { JsonFileCursorStore } from '../src/state-file.ts'

const pr: PullRequest = {
  number: 42,
  title: 't',
  body: '',
  htmlUrl: 'u',
  draft: false,
  head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo' } },
  base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo' } },
}

const account: ResolvedAccountConfig = {
  appId: '1',
  installationId: '2',
  privateKeyPath: '/unused.pem',
  baseUrl: 'https://api.github.com',
  webUrl: 'https://github.com',
  pollIntervalMs: 120_000,
  repositories: ['owner/repo'],
  review: { maxToolCalls: 30, toolTimeoutMs: 5000, toolResultLimit: 60000, timeoutMs: 30_000, defaultInstructions: '' },
  mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
  statePath: '',
}

const signal = new AbortController().signal

interface FakeReviewComment {
  id: number
  body: string
  user: { login: string; type: string }
  createdAt: Date
  htmlUrl: string
  path: string
  inReplyTo: number
}

interface FakeClient {
  prs: PullRequest[]
  instructions: { text: string; source: string } | 'missing'
  issueComments: Array<{ id: number; body: string; user: { login: string; type: string }; createdAt: Date; htmlUrl: string }>
  reviewComments: FakeReviewComment[]
  issueCommentCalls: string[]
  reviewReplyCalls: Array<{ commentId: number; body: string }>
  listOpenPullRequests: GitHubClient['listOpenPullRequests']
  reviewInstructions: GitHubClient['reviewInstructions']
  listIssueComments: GitHubClient['listIssueComments']
  listReviewComments: GitHubClient['listReviewComments']
  createIssueComment: GitHubClient['createIssueComment']
  createReviewCommentReply: GitHubClient['createReviewCommentReply']
}

function fakeClient(): FakeClient {
  const c: FakeClient = {
    prs: [],
    instructions: 'missing',
    issueComments: [],
    reviewComments: [],
    issueCommentCalls: [],
    reviewReplyCalls: [],
    listOpenPullRequests: async () => c.prs,
    reviewInstructions: async () => (c.instructions === 'missing' ? { ok: false } : { ok: true, instructions: c.instructions }),
    listIssueComments: async () => c.issueComments,
    listReviewComments: async () => c.reviewComments,
    createIssueComment: async (_repo, _number, body) => { c.issueCommentCalls.push(body) },
    createReviewCommentReply: async (_repo, _number, commentId, body) => { c.reviewReplyCalls.push({ commentId, body }) },
  }
  return c
}

/** A scripted review driver recording every turn. */
function fakeDriver() {
  const reviewCalls: Array<{ pr: PullRequest; instructions: { text: string; source: string } }> = []
  const chatCalls: Array<{ pr: PullRequest; message: string }> = []
  const driver: ReviewDriver = {
    driveReview: vi.fn(async (target, instructions) => {
      reviewCalls.push({ pr: target, instructions })
      return { submitted: true, text: 'Reviewed.' }
    }),
    driveChat: vi.fn(async (target, message) => {
      chatCalls.push({ pr: target, message })
      return 'The reply.'
    }),
    dispose: vi.fn(async () => {}),
  }
  return { driver, reviewCalls, chatCalls }
}

let dir: string
let store: JsonFileCursorStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-'))
  store = new JsonFileCursorStore(join(dir, 'cursor.json'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function buildPoller(
  c: FakeClient,
  driver: ReviewDriver,
  lines: string[],
  instructions: { text: string; source: string } | 'missing' = 'missing',
  defaultInstructions = '',
) {
  const resolved = { ...account, review: { ...account.review, defaultInstructions } }
  c.instructions = instructions
  return new AccountPoller({
    accountName: 'reviewer',
    account: resolved,
    client: c as unknown as GitHubClient,
    tokenSource: { token: async () => 'installation-token' },
    store,
    driver,
    logger: recordingLogger(lines),
  })
}

describe('AccountPoller review flow', () => {
  it('reviews a new PR and marks the cursor reviewed', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'owner/repo@main' })

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(1)
    expect(reviewCalls[0].instructions.text).toBe('trusted')
    const state = JSON.parse(await readFile(store.filePath, 'utf8')) as { prs: Record<string, { status: string; headSHA: string }> }
    expect(state.prs['owner/repo#42'].status).toBe('reviewed')
    expect(lines.some(line => line.includes('github review submitted'))).toBe(true)
  })

  it('does not re-review an unchanged reviewed PR', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(1)
  })

  it('skips draft PRs', async () => {
    const c = fakeClient()
    c.prs = [{ ...pr, draft: true }]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('skipping draft github pr'))).toBe(true)
  })

  it('marks missing instructions and retries only after the head SHA changes', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, 'missing')

    await poller.pollOnce(signal)
    const state = JSON.parse(await readFile(store.filePath, 'utf8')) as { prs: Record<string, { status: string }> }
    expect(state.prs['owner/repo#42'].status).toBe('missing_instructions')
    expect(reviewCalls).toHaveLength(0)

    await poller.pollOnce(signal)
    expect(reviewCalls).toHaveLength(0)

    c.prs = [{ ...pr, head: { ...pr.head, sha: 'head-sha-2' } }]
    await poller.pollOnce(signal)
    expect(reviewCalls).toHaveLength(0)
    await poller.dispose()
  })

  it('falls back to configured default instructions', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, 'missing', 'review carefully')

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(1)
    expect(reviewCalls[0].instructions.text).toBe('review carefully')
    expect(lines.some(line => line.includes('falling back to config default_instructions'))).toBe(true)
  })

  it('does not mark the cursor when the review did not submit a COMMENT review', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const driver: ReviewDriver = {
      driveReview: async () => ({ submitted: false, text: 'failed to inspect' }),
      driveChat: async () => '',
      dispose: async () => {},
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    const state = await store.load()
    expect(state.prs['owner/repo#42']).toBeUndefined()
    expect(lines.some(line => line.includes('completed without COMMENT submission'))).toBe(true)
    await poller.dispose()
  })
})

describe('AccountPoller comment commands', () => {
  function reviewedPoller(c: FakeClient, driver: ReviewDriver, lines: string[]) {
    return buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })
  }

  it('answers /bot comments with an issue comment reply', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)

    c.issueComments = [
      { id: 9, body: '/bot explain this', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0].message).toBe('explain this')
    expect(c.issueCommentCalls).toEqual(['The reply.'])
    expect(lines.some(line => line.includes('github bot chat triggered by comment'))).toBe(true)
  })

  it('triggers a re-review on /review and skips later comments', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)
    const firstCalls = reviewCalls.length

    c.issueComments = [
      { id: 1, body: '/review', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
      { id: 2, body: '/bot ignored', user: { login: 'bob', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls.length).toBeGreaterThan(firstCalls)
    expect(c.issueCommentCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('github re-review submitted'))).toBe(true)
  })

  it('replies to review-thread comments in their thread', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)

    c.issueComments = []
    c.reviewComments = [
      { id: 5, body: '/bot details?', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u', path: 'a.ts', inReplyTo: 0 },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(c.reviewReplyCalls).toEqual([{ commentId: 5, body: 'The reply.' }])
  })

  it('ignores comments from bots', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)
    const firstReviewCalls = reviewCalls.length

    c.issueComments = [
      { id: 3, body: '/bot hi', user: { login: 'ghost', type: 'Bot' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(firstReviewCalls)
    expect(chatCalls).toHaveLength(0)
    expect(c.issueCommentCalls).toHaveLength(0)
  })
})

describe('AccountPoller failure paths', () => {
  it('continues past a repo whose PR listing fails', async () => {
    const c = fakeClient()
    c.listOpenPullRequests = async () => { throw new Error('rate limited') }
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('list github pull requests failed'))).toBe(true)
  })

  it('marks missing instructions when reading them fails', async () => {
    const c = fakeClient()
    c.prs = [pr]
    c.reviewInstructions = async () => { throw new Error('api down') }
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines)

    await poller.pollOnce(signal)
    const state = await store.load()
    expect(state.prs['owner/repo#42'].status).toBe('missing_instructions')
    expect(reviewCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('read github review instructions failed'))).toBe(true)
    await poller.dispose()
  })

  it('surfaces a review driver failure without marking the cursor', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const driver: ReviewDriver = {
      driveReview: async () => { throw new Error('loop down') },
      driveChat: async () => '',
      dispose: async () => {},
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    const state = await store.load()
    expect(state.prs['owner/repo#42']).toBeUndefined()
    expect(lines.some(line => line.includes('github review failed'))).toBe(true)
    await poller.dispose()
  })

  it('continues past a comment poll failure', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })
    await poller.pollOnce(signal)

    c.listIssueComments = async () => { throw new Error('boom') }
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(lines.some(line => line.includes('github comment poll failed'))).toBe(true)
  })

  it('surfaces a chat driver failure without posting', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const driver: ReviewDriver = {
      driveReview: async () => ({ submitted: true, text: 'ok' }),
      driveChat: async () => { throw new Error('loop down') },
      dispose: async () => {},
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })
    await poller.pollOnce(signal)

    c.issueComments = [
      { id: 9, body: '/bot explain this', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(c.issueCommentCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('github bot chat failed'))).toBe(true)
  })
})
