import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedAccountConfig } from '../src/config.ts'
import { GitHubRateLimitError } from '../src/github/client.ts'
import type { GitHubClient } from '../src/github/client.ts'
import type { PullRequest } from '../src/github/model.ts'
import { AccountPoller, recordingLogger } from '../src/poller.ts'
import type { ReviewDriver } from '../src/poller.ts'
import type { CursorStore } from '../src/cursor-store.ts'
import { emptyCursorState } from '../src/github/cursor.ts'

const pr: PullRequest = {
  number: 42,
  title: 't',
  body: '',
  htmlUrl: 'u',
  draft: false,
  changedFiles: 3,
  additions: 10,
  deletions: 2,
  head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo' } },
  base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo' } },
}

const account: ResolvedAccountConfig = {
  name: 'reviewer',
  appId: '1',
  installationId: '2',
  privateKeyPath: '/unused.pem',
  baseUrl: 'https://api.github.com',
  webUrl: 'https://github.com',
  pollIntervalMs: 120_000,
  repositories: ['owner/repo'],
  workspaceDir: '/tmp/ghr-workspace',
  workspaceTitle: 'GithubReviewer',
  review: {
    maxToolCalls: 30,
    toolTimeoutMs: 5000,
    toolResultLimit: 60000,
    timeoutMs: 30_000,
    defaultInstructions: '',
    commandAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    models: [],
  },
  mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
}

const signal = new AbortController().signal

interface FakeReviewComment {
  id: number
  body: string
  user: { login: string; type: string }
  authorAssociation: string
  createdAt: Date
  htmlUrl: string
  path: string
  inReplyTo: number
}

interface FakeIssueComment {
  id: number
  body: string
  user: { login: string; type: string }
  authorAssociation: string
  createdAt: Date
  htmlUrl: string
}

/** Shorthand for an authorized (OWNER) issue comment. */
function issueComment(id: number, body: string, createdAt = new Date()): FakeIssueComment {
  return { id, body, user: { login: 'alice', type: 'User' }, authorAssociation: 'OWNER', createdAt, htmlUrl: 'u' }
}

interface FakeClient {
  prs: PullRequest[]
  instructions: { text: string; source: string } | 'missing'
  issueComments: FakeIssueComment[]
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
    listOpenPullRequests: vi.fn(async () => c.prs),
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

/** An in-memory cursor store standing in for the storage domain. */
function fakeStore(): CursorStore {
  let state = emptyCursorState()
  return {
    load: async () => state,
    save: async (next) => { state = next },
  }
}

let store: CursorStore

beforeEach(() => {
  store = fakeStore()
})

function buildPoller(
  c: FakeClient,
  driver: ReviewDriver,
  lines: string[],
  instructions: { text: string; source: string } | 'missing' = 'missing',
  defaultInstructions = '',
  repositories = account.repositories,
) {
  const resolved = { ...account, repositories, review: { ...account.review, defaultInstructions } }
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
  it('stays idle without calling GitHub when no repositories are configured', async () => {
    const c = fakeClient()
    const { driver } = fakeDriver()
    const poller = buildPoller(c, driver, [], 'missing', '', [])

    await poller.pollOnce(signal)

    expect(c.listOpenPullRequests).not.toHaveBeenCalled()
    expect(driver.driveReview).not.toHaveBeenCalled()
    await poller.dispose()
  })

  it('skips invalid repositories and stops before listing when already aborted', async () => {
    const c = fakeClient()
    const { driver } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, 'missing', '', ['not-a-repo', 'owner/repo'])

    await poller.pollOnce(signal)
    expect(lines.some(line => line.includes('skipping invalid github repo'))).toBe(true)
    expect(c.listOpenPullRequests).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    controller.abort()
    await poller.pollOnce(controller.signal)
    expect(c.listOpenPullRequests).toHaveBeenCalledTimes(1)
    await poller.dispose()
  })

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
    const state = await store.load()
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
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(0)
    expect(lines.filter(line => line.includes('skipping draft github pr'))).toHaveLength(1)
  })

  it('marks missing instructions and retries only after the head SHA changes', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, 'missing')

    await poller.pollOnce(signal)
    const state = await store.load()
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

  it('records a failure (with backoff state) when the review did not submit a COMMENT review', async () => {
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
    const entry = state.prs['owner/repo#42']
    expect(entry?.status).toBe('reviewing')
    expect(entry?.failCount).toBe(1)
    expect(entry?.lastFailedSHA).toBe('head-sha')
    expect(lines.some(line => line.includes('completed without COMMENT submission'))).toBe(true)
    await poller.dispose()
  })

  it('backs off repeated failures against the same head SHA and retries after a new push', async () => {
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
    // Second tick: the same SHA is in backoff, so no new attempt is made.
    await poller.pollOnce(signal)
    let state = await store.load()
    expect(state.prs['owner/repo#42'].failCount).toBe(1)
    expect(lines.some(line => line.includes('backing off'))).toBe(true)

    // A new head SHA resets the backoff and retries immediately.
    c.prs = [{ ...pr, head: { ...pr.head, sha: 'head-sha-2' } }]
    await poller.pollOnce(signal)
    state = await store.load()
    expect(state.prs['owner/repo#42'].failCount).toBe(1)
    expect(state.prs['owner/repo#42'].lastFailedSHA).toBe('head-sha-2')
    await poller.dispose()
  })

  it('persists the reviewing marker while a review is in flight', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const seen: Array<string | undefined> = []
    const driver: ReviewDriver = {
      driveReview: vi.fn(async () => {
        seen.push((await store.load()).prs['owner/repo#42']?.status)
        return { submitted: true, text: 'done' }
      }),
      driveChat: async () => '',
      dispose: async () => {},
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })
    await poller.pollOnce(signal)
    await poller.dispose()
    expect(seen).toEqual(['reviewing'])
    expect((await store.load()).prs['owner/repo#42'].status).toBe('reviewed')
  })

  it('leaves an interrupted review marked reviewing with failure state', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const driver: ReviewDriver = {
      driveReview: async () => { throw new Error('process died mid-review') },
      driveChat: async () => '',
      dispose: async () => {},
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })
    await poller.pollOnce(signal)
    await poller.dispose()
    const entry = (await store.load()).prs['owner/repo#42']
    expect(entry.status).toBe('reviewing')
    expect(entry.failCount).toBe(1)
    expect(entry.lastFailedSHA).toBe('head-sha')
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

    c.issueComments = [issueComment(9, '/bot explain this')]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0].message).toBe('explain this')
    expect(c.issueCommentCalls).toEqual(['The reply.'])
    expect(lines.some(line => line.includes('github bot chat triggered by comment'))).toBe(true)
  })

  it('does not post an empty bot reply', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver } = fakeDriver()
    driver.driveChat = vi.fn(async () => '')
    const poller = reviewedPoller(c, driver, [])
    await poller.pollOnce(signal)

    c.issueComments = [issueComment(10, '/bot stay silent')]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(c.issueCommentCalls).toHaveLength(0)
  })

  it('triggers a re-review on /review and still answers later comments', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)
    const firstCalls = reviewCalls.length

    c.issueComments = [
      issueComment(1, '/review', new Date(Date.now() + 1000)),
      { ...issueComment(2, '/bot still answer me'), user: { login: 'bob', type: 'User' } },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls.length).toBeGreaterThan(firstCalls)
    expect(chatCalls).toHaveLength(1)
    expect(c.issueCommentCalls).toEqual(['The reply.'])
    expect(lines.some(line => line.includes('github review submitted'))).toBe(true)
  })

  it('ignores commands from commenters without an allowed author association', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, reviewCalls, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)
    const firstReviewCalls = reviewCalls.length

    c.issueComments = [
      { ...issueComment(7, '/review'), authorAssociation: 'NONE', user: { login: 'stranger', type: 'User' } },
      { ...issueComment(8, '/bot hi'), authorAssociation: 'FIRST_TIME_CONTRIBUTOR', user: { login: 'newbie', type: 'User' } },
    ]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(reviewCalls).toHaveLength(firstReviewCalls)
    expect(chatCalls).toHaveLength(0)
    expect(c.issueCommentCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('ignoring github comment command from unauthorized author'))).toBe(true)
  })

  it('does not reprocess the boundary comment on the next tick', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)

    const commentAt = new Date()
    const comment = issueComment(11, '/bot hello', commentAt)
    c.issueComments = [comment]
    await poller.pollOnce(signal)
    expect(chatCalls).toHaveLength(1)

    // The client-side boundary is the comment's createdAt; GitHub's inclusive
    // `since` would return the same comment again, so the poller must filter it.
    const state = await store.load()
    expect(state.prs['owner/repo#42'].lastCommentCheck).toBe(commentAt.toISOString())
    await poller.pollOnce(signal)
    await poller.dispose()
    expect(chatCalls).toHaveLength(1)
    expect(c.issueCommentCalls).toHaveLength(1)
  })

  it('does not replay already-answered comments when a later reply fails mid-batch', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const { driver, chatCalls } = fakeDriver()
    const lines: string[] = []
    const poller = reviewedPoller(c, driver, lines)
    await poller.pollOnce(signal)

    c.issueComments = [
      issueComment(20, '/bot first', new Date(Date.now() + 1000)),
      issueComment(21, '/bot second', new Date(Date.now() + 2000)),
    ]
    const originalCreate = c.createIssueComment.bind(c)
    let calls = 0
    c.createIssueComment = async (repo, number, body, sig) => {
      calls++
      if (calls === 2) throw new Error('post failed')
      return originalCreate(repo, number, body, sig)
    }
    await poller.pollOnce(signal)
    expect(chatCalls).toHaveLength(2)
    expect(c.issueCommentCalls).toEqual(['The reply.'])
    expect(lines.some(line => line.includes('github bot chat failed'))).toBe(true)

    // Next tick: the answered comment is not re-answered, and the failed one
    // is not retried either (processed ids are recorded to avoid retry storms;
    // the user can re-comment to retry).
    await poller.pollOnce(signal)
    await poller.dispose()
    expect(chatCalls).toHaveLength(2)
    expect(c.issueCommentCalls).toEqual(['The reply.'])
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
      { id: 5, body: '/bot details?', user: { login: 'alice', type: 'User' }, authorAssociation: 'MEMBER', createdAt: new Date(), htmlUrl: 'u', path: 'a.ts', inReplyTo: 0 },
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
      { ...issueComment(3, '/bot hi'), user: { login: 'ghost', type: 'Bot' } },
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

  it('does not touch the cursor when reading instructions fails transiently', async () => {
    const c = fakeClient()
    c.prs = [pr]
    c.reviewInstructions = async () => { throw new Error('api down') }
    const { driver, reviewCalls } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines)

    await poller.pollOnce(signal)
    let state = await store.load()
    expect(state.prs['owner/repo#42']).toBeUndefined()
    expect(reviewCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('read github review instructions failed'))).toBe(true)

    // The next tick retries: transient errors are not recorded in the cursor.
    c.reviewInstructions = async () => ({ ok: true, instructions: { text: 'trusted', source: 'x' } })
    await poller.pollOnce(signal)
    state = await store.load()
    expect(reviewCalls).toHaveLength(1)
    expect(state.prs['owner/repo#42'].status).toBe('reviewed')
    await poller.dispose()
  })

  it('surfaces a review driver failure by recording backoff state', async () => {
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
    const entry = state.prs['owner/repo#42']
    expect(entry?.status).toBe('reviewing')
    expect(entry?.failCount).toBe(1)
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

    c.issueComments = [issueComment(9, '/bot explain this')]
    await poller.pollOnce(signal)
    await poller.dispose()

    expect(c.issueCommentCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('github bot chat failed'))).toBe(true)
  })

  it('stops the tick early when the API is rate limited', async () => {
    const c = fakeClient()
    c.listOpenPullRequests = async () => {
      throw new GitHubRateLimitError('GET', '/repos/owner/repo/pulls', 429, 'limited', 60)
    }
    const { driver } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(lines.some(line => line.includes('github rate limited') && line.includes('retry_after_s=60'))).toBe(true)
  })

  it('logs rate limiting without a retry hint when GitHub omits it', async () => {
    const c = fakeClient()
    c.listOpenPullRequests = async () => {
      throw new GitHubRateLimitError('GET', '/repos/owner/repo/pulls', 403, 'limited')
    }
    const { driver } = fakeDriver()
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    await poller.dispose()

    expect(lines.some(line => line.includes('github rate limited') && !line.includes('retry_after_s='))).toBe(true)
  })

  it('dispose waits for an in-flight tick to finish', async () => {
    const c = fakeClient()
    c.prs = [pr]
    let releaseReview: (() => void) | undefined
    let reviewStarted: (() => void) | undefined
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve })
    const reviewEntered = new Promise<void>(resolve => { reviewStarted = resolve })
    let disposeResolvedWhileInFlight = false
    let driverDisposeStarted = false
    const driver: ReviewDriver = {
      driveReview: async () => {
        reviewStarted?.()
        await reviewGate
        return { submitted: true, text: 'ok' }
      },
      driveChat: async () => '',
      dispose: async () => { driverDisposeStarted = true },
    }
    const lines: string[] = []
    const poller = buildPoller(c, driver, lines, { text: 'trusted', source: 'x' })

    poller.start()
    poller.start()
    // Wait until the single immediate tick is actually blocked inside driveReview.
    await reviewEntered
    const disposal = poller.dispose()
    expect(poller.dispose()).toBe(disposal)
    const disposed = disposal.then(() => { disposeResolvedWhileInFlight = true })
    expect(driverDisposeStarted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposeResolvedWhileInFlight).toBe(false)
    releaseReview?.()
    await disposed
    expect(disposeResolvedWhileInFlight).toBe(true)
  })
})
