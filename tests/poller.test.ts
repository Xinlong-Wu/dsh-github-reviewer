import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ResolvedAccountConfig } from '../src/config.ts'
import type { GitHubClient } from '../src/github/client.ts'
import type { PullRequest } from '../src/github/model.ts'
import type { McpHost } from '../src/github/mcp-host.ts'
import { AccountPoller, recordingLogger } from '../src/poller.ts'
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
  provider: 'deepseek',
  model: 'deepseek-chat',
  review: { maxToolCalls: 30, toolTimeoutMs: 5000, toolResultLimit: 60000, timeoutMs: 30_000, defaultInstructions: '' },
  mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
  statePath: '',
}

const signal = new AbortController().signal
const rawTools = [
  { name: 'mcp_github_pull_request_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_get_file_contents', description: 'file', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_pull_request_review_write', description: 'write', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_add_comment_to_pending_review', description: 'comment', inputSchema: { type: 'object', properties: {} } },
]

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

const text = (value: string): StreamChunk => ({ type: 'block-end', index: 0, block: { type: 'text', text: value } })
const toolCall = (id: string, name: string, args: string): StreamChunk => ({
  type: 'block-end',
  index: 1,
  block: { type: 'tool-call', id: CallId(id), name, arguments: args },
})
const stop = (): StreamChunk => ({ type: 'finish', reason: { kind: 'stop' } })
const moreTools = (): StreamChunk => ({ type: 'finish', reason: { kind: 'tool-calls' } })

/** Scripted LLM streamer: plays each scripted turn, then repeats the last. */
function scripted(initial: StreamChunk[][], streamCalls: Array<unknown[]> = []) {
  let turns = initial
  let index = 0
  return {
    streamCalls,
    setTurns: (next: StreamChunk[][]) => { turns = next; index = 0 },
    stream: vi.fn((_options: unknown) => {
      streamCalls.push([_options])
      const chunks = turns[Math.min(index, turns.length - 1)] ?? []
      index++
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
    }),
  }
}

const submitReviewTurns: StreamChunk[][] = [
  [toolCall('c1', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create' })), moreTools()],
  [toolCall('c2', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' })), moreTools()],
  [text('Reviewed.'), stop()],
]

let dir: string
let store: JsonFileCursorStore
let mcpCalls: Array<{ remote: string; args: Record<string, unknown> }>
let lastToken: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-'))
  store = new JsonFileCursorStore(join(dir, 'cursor.json'))
  mcpCalls = []
  lastToken = ''
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeHost(): McpHost {
  return {
    listTools: async () => rawTools,
    call: async (remote, args) => {
      mcpCalls.push({ remote, args })
      return { content: 'ok', isError: false }
    },
    close: async () => {},
  }
}

function buildPoller(
  c: FakeClient,
  llm: ReturnType<typeof scripted>,
  lines: string[],
  instructions: { text: string; source: string } | 'missing' = 'missing',
  defaultInstructions = '',
) {
  const resolved = { ...account, review: { ...account.review, defaultInstructions } }
  const poller = new AccountPoller({
    accountName: 'reviewer',
    account: resolved,
    llm,
    client: c as unknown as GitHubClient,
    tokenSource: { token: async () => 'installation-token' },
    store,
    logger: recordingLogger(lines),
    mcpHostFactory: async (token) => {
      lastToken = token
      return fakeHost()
    },
  })
  c.instructions = instructions
  return poller
}

describe('AccountPoller review flow', () => {
  it('reviews a new PR, injects the installation token, and marks the cursor reviewed', async () => {
    const c = fakeClient()
    c.prs = [pr]
    c.instructions = { text: 'trusted', source: 'owner/repo@main' }
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = buildPoller(c, llm, lines, { text: 'trusted', source: 'owner/repo@main' })

    await poller.pollOnce(signal)
    poller.dispose()

    expect(lastToken).toBe('installation-token')
    expect(mcpCalls).toHaveLength(2)
    expect(mcpCalls[0].args.method).toBe('create')
    expect(mcpCalls[1].args).toEqual({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' })
    const state = JSON.parse(await readFile(store.filePath, 'utf8')) as { prs: Record<string, { status: string; headSHA: string }> }
    expect(state.prs['owner/repo#42'].status).toBe('reviewed')
    expect(lines.some(line => line.includes('github review submitted'))).toBe(true)
  })

  it('does not re-review an unchanged reviewed PR', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = buildPoller(c, llm, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    const firstCalls = llm.streamCalls.length
    await poller.pollOnce(signal)
    poller.dispose()

    expect(llm.streamCalls.length).toBe(firstCalls)
  })

  it('skips draft PRs', async () => {
    const c = fakeClient()
    c.prs = [{ ...pr, draft: true }]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = buildPoller(c, llm, lines, { text: 'trusted', source: 'x' })

    await poller.pollOnce(signal)
    poller.dispose()

    expect(llm.streamCalls.length).toBe(0)
    expect(lines.some(line => line.includes('skipping draft github pr'))).toBe(true)
  })

  it('marks missing instructions and retries only after the head SHA changes', async () => {
    const c = fakeClient()
    c.prs = [pr]
    c.instructions = 'missing'
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = buildPoller(c, llm, lines, 'missing')

    await poller.pollOnce(signal)
    const state = JSON.parse(await readFile(store.filePath, 'utf8')) as { prs: Record<string, { status: string }> }
    expect(state.prs['owner/repo#42'].status).toBe('missing_instructions')
    expect(llm.streamCalls.length).toBe(0)

    await poller.pollOnce(signal)
    expect(llm.streamCalls.length).toBe(0)

    c.prs = [{ ...pr, head: { ...pr.head, sha: 'head-sha-2' } }]
    await poller.pollOnce(signal)
    expect(llm.streamCalls.length).toBe(0)
    poller.dispose()
  })

  it('falls back to configured default instructions', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = buildPoller(c, llm, lines, 'missing', 'review carefully')

    await poller.pollOnce(signal)
    poller.dispose()

    expect(llm.streamCalls.length).toBeGreaterThan(0)
    expect(lines.some(line => line.includes('falling back to config default_instructions'))).toBe(true)
  })
})

describe('AccountPoller comment commands', () => {
  function reviewedPoller(c: FakeClient, llm: ReturnType<typeof scripted>, lines: string[]) {
    return buildPoller(c, llm, lines, { text: 'trusted', source: 'x' })
  }

  it('answers /bot comments with an issue comment reply', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const chatTurns: StreamChunk[][] = [
      [toolCall('c1', 'mcp_github_pull_request_read', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get' })), moreTools()],
      [text('The PR changes the login flow.'), stop()],
    ]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = reviewedPoller(c, llm, lines)
    await poller.pollOnce(signal)

    c.issueComments = [
      { id: 9, body: '/bot explain this', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    llm.setTurns(chatTurns)
    await poller.pollOnce(signal)
    poller.dispose()

    expect(c.issueCommentCalls).toEqual(['The PR changes the login flow.'])
    expect(lines.some(line => line.includes('github bot chat triggered by comment'))).toBe(true)
  })

  it('triggers a re-review on /review and skips later comments', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = reviewedPoller(c, llm, lines)
    await poller.pollOnce(signal)
    const firstCalls = llm.streamCalls.length

    c.issueComments = [
      { id: 1, body: '/review', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
      { id: 2, body: '/bot ignored', user: { login: 'bob', type: 'User' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    llm.setTurns(submitReviewTurns)
    await poller.pollOnce(signal)
    poller.dispose()

    expect(llm.streamCalls.length).toBeGreaterThan(firstCalls)
    expect(c.issueCommentCalls).toHaveLength(0)
    expect(lines.some(line => line.includes('github re-review submitted'))).toBe(true)
  })

  it('replies to review-thread comments in their thread', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const chatTurns: StreamChunk[][] = [[text('Reply in thread.'), stop()]]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = reviewedPoller(c, llm, lines)
    await poller.pollOnce(signal)

    c.issueComments = []
    c.reviewComments = [
      { id: 5, body: '/bot details?', user: { login: 'alice', type: 'User' }, createdAt: new Date(), htmlUrl: 'u', path: 'a.ts', inReplyTo: 0 },
    ]
    llm.setTurns(chatTurns)
    await poller.pollOnce(signal)
    poller.dispose()

    expect(c.reviewReplyCalls).toEqual([{ commentId: 5, body: 'Reply in thread.' }])
  })

  it('ignores comments from bots', async () => {
    const c = fakeClient()
    c.prs = [pr]
    const llm = scripted(submitReviewTurns)
    const lines: string[] = []
    const poller = reviewedPoller(c, llm, lines)
    await poller.pollOnce(signal)
    const firstCalls = llm.streamCalls.length

    c.issueComments = [
      { id: 3, body: '/bot hi', user: { login: 'ghost', type: 'Bot' }, createdAt: new Date(), htmlUrl: 'u' },
    ]
    await poller.pollOnce(signal)
    poller.dispose()

    expect(llm.streamCalls.length).toBe(firstCalls)
    expect(c.issueCommentCalls).toHaveLength(0)
  })
})
