import { describe, expect, it } from 'vitest'
import { ReviewGuardState, guardReviewTools } from '../src/github/guard.ts'
import type { GuardedToolResult, GuardLogger, RawMcpTool } from '../src/github/guard.ts'
import type { PullRequest } from '../src/github/model.ts'

const pr: PullRequest = {
  number: 42,
  title: 't',
  body: '',
  htmlUrl: 'u',
  draft: false,
  head: { sha: 'head-sha', ref: 'feature', repo: { owner: 'forker', name: 'repo' } },
  base: { sha: 'base-sha', ref: 'main', repo: { owner: 'owner', name: 'repo' } },
}

const signal = new AbortController().signal
const silent: GuardLogger = { warn: () => {}, debug: () => {} }

function tool(remote: string, inputSchema: Record<string, unknown> = { type: 'object', properties: {} }): RawMcpTool {
  return { name: `mcp_github_${remote}`, description: `description of ${remote}`, inputSchema }
}

interface RecordedCall {
  remote: string
  args: Record<string, unknown>
}

function setup(tools: RawMcpTool[], executorResult: GuardedToolResult = { content: 'ok', isError: false }) {
  const state = new ReviewGuardState()
  const calls: RecordedCall[] = []
  const guarded = guardReviewTools(tools, pr, state, {
    call: async (remote, args) => {
      calls.push({ remote, args })
      return executorResult
    },
  }, silent)
  return { state, calls, guarded }
}

describe('guardReviewTools filtering', () => {
  it('wraps allowed tools and renames them with the mcp_github_ prefix', () => {
    const { guarded } = setup([tool('pull_request_read')])
    expect(guarded).toHaveLength(1)
    expect(guarded[0].spec().name).toBe('mcp_github_pull_request_read')
  })

  it('skips non-github and disallowed tools', () => {
    const { guarded } = setup([
      tool('some_other_server_tool'),
      tool('merge_pull_request'),
      tool('pull_request_read'),
    ])
    expect(guarded).toHaveLength(1)
  })

  it('skips duplicate remote names', () => {
    const { guarded } = setup([tool('pull_request_read'), tool('pull_request_read')])
    expect(guarded).toHaveLength(1)
  })
})

describe('pull_request_read guard', () => {
  it('allows get/get_diff/get_files/get_status/get_check_runs on the current PR', async () => {
    const { guarded, calls } = setup([tool('pull_request_read')])
    for (const method of ['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs']) {
      const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method }, signal)
      expect(result.isError).toBe(false)
    }
    expect(calls).toHaveLength(5)
  })

  it('rejects disallowed read methods', async () => {
    const { guarded, calls } = setup([tool('pull_request_read')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get_comments' }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not allowed')
    expect(calls).toHaveLength(0)
  })

  it('rejects calls targeting another PR', async () => {
    const { guarded, calls } = setup([tool('pull_request_read')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 43, method: 'get' }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('must target current PR')
    expect(calls).toHaveLength(0)
  })

  it('rejects a mismatched repository', async () => {
    const { guarded } = setup([tool('pull_request_read')])
    const result = await guarded[0].execute({ owner: 'other', repo: 'repo', pullNumber: 42, method: 'get' }, signal)
    expect(result.isError).toBe(true)
  })
})

describe('get_file_contents guard', () => {
  it('allows base/head repos and defaults sha to head when omitted', async () => {
    const { guarded, calls } = setup([tool('get_file_contents')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', path: 'a.ts' }, signal)
    expect(result.isError).toBe(false)
    expect(calls[0].args.sha).toBe('head-sha')
    expect(calls[0].args.ref).toBeUndefined()
  })

  it('rejects third-party repositories', async () => {
    const { guarded } = setup([tool('get_file_contents')])
    const result = await guarded[0].execute({ owner: 'other', repo: 'repo', path: 'a.ts' }, signal)
    expect(result.isError).toBe(true)
  })

  it('rejects passing both sha and ref', async () => {
    const { guarded } = setup([tool('get_file_contents')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', path: 'a.ts', sha: 'head-sha', ref: 'main' }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('both sha and ref')
  })

  it('rejects SHAs that are not the base or head SHA', async () => {
    const { guarded } = setup([tool('get_file_contents')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', path: 'a.ts', sha: 'main' }, signal)
    expect(result.isError).toBe(true)
  })

  it('allows base branch refs, head branch refs, and refs/pull/N/head', async () => {
    const { guarded } = setup([tool('get_file_contents')])
    for (const [owner, ref] of [
      ['owner', 'main'],
      ['owner', 'refs/heads/main'],
      ['owner', 'refs/pull/42/head'],
      ['forker', 'feature'],
    ] as const) {
      const result = await guarded[0].execute({ owner, repo: 'repo', path: 'a.ts', ref }, signal)
      expect(result.isError, `ref ${ref} on ${owner}`).toBe(false)
    }
  })

  it('rejects the head branch ref on the base repo', async () => {
    const { guarded } = setup([tool('get_file_contents')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', path: 'a.ts', ref: 'feature' }, signal)
    expect(result.isError).toBe(true)
  })
})

describe('pull_request_review_write guard', () => {
  it('injects commitID and drops event/body/extra args on create', async () => {
    const { guarded, calls } = setup([tool('pull_request_review_write')])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', event: 'APPROVE', body: 'x', note: 'y' },
      signal,
    )
    expect(result.isError).toBe(false)
    expect(calls[0].args).toEqual({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'head-sha' })
  })

  it('accepts the exact head SHA as commitID', async () => {
    const { guarded, calls } = setup([tool('pull_request_review_write')])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'head-sha' },
      signal,
    )
    expect(result.isError).toBe(false)
    expect(calls[0].args.commitID).toBe('head-sha')
  })

  it('rejects a wrong commitID', async () => {
    const { guarded } = setup([tool('pull_request_review_write')])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'other' },
      signal,
    )
    expect(result.isError).toBe(true)
  })

  it('rejects submit_pending without event=COMMENT', async () => {
    const { guarded } = setup([tool('pull_request_review_write')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'APPROVE' }, signal)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('event=COMMENT')
  })

  it('rejects unknown methods', async () => {
    const { guarded } = setup([tool('pull_request_review_write')])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'dismiss' }, signal)
    expect(result.isError).toBe(true)
  })

  it('marks submittedComment only after a successful COMMENT submit', async () => {
    const { guarded, state } = setup([tool('pull_request_review_write')])
    await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' }, signal)
    expect(state.submittedComment).toBe(true)
    expect(state.submitAttempted).toBe(true)
  })

  it('does not mark submittedComment when submit fails', async () => {
    const { guarded, state } = setup([tool('pull_request_review_write')], { content: 'boom', isError: true })
    await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' }, signal)
    expect(state.submittedComment).toBe(false)
  })
})

describe('add_comment_to_pending_review guard', () => {
  const commentTool = () => tool('add_comment_to_pending_review', {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      pullNumber: { type: 'number' },
      path: { type: 'string' },
      body: { type: 'string' },
      subjectType: { type: 'string' },
      line: { type: 'number' },
      side: { type: 'string' },
      startLine: { type: 'number' },
      startSide: { type: 'string' },
    },
  })

  it('accepts FILE comments without line/side', async () => {
    const { guarded, calls } = setup([commentTool()])
    const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'FILE' }, signal)
    expect(result.isError).toBe(false)
    expect(calls[0].args.subjectType).toBe('FILE')
  })

  it('rejects FILE comments carrying startLine', async () => {
    const { guarded } = setup([commentTool()])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'FILE', startLine: 3 },
      signal,
    )
    expect(result.isError).toBe(true)
  })

  it('accepts LINE comments with line and side', async () => {
    const { guarded } = setup([commentTool()])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3, side: 'RIGHT' },
      signal,
    )
    expect(result.isError).toBe(false)
  })

  it('rejects LINE comments without a line or side', async () => {
    const { guarded } = setup([commentTool()])
    expect((await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', side: 'RIGHT' },
      signal,
    )).isError).toBe(true)
    expect((await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3 },
      signal,
    )).isError).toBe(true)
  })

  it('requires startLine and startSide together', async () => {
    const { guarded } = setup([commentTool()])
    expect((await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 5, side: 'RIGHT', startLine: 3 },
      signal,
    )).isError).toBe(true)
    expect((await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 5, side: 'RIGHT', startLine: 3, startSide: 'RIGHT' },
      signal,
    )).isError).toBe(false)
  })

  it('rejects absolute and traversal paths', async () => {
    const { guarded } = setup([commentTool()])
    for (const path of ['/etc/passwd', '../secret', 'a\0b']) {
      const result = await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, path, body: 'fix', subjectType: 'FILE' }, signal)
      expect(result.isError, path).toBe(true)
    }
  })

  it('rejects unknown subjectType', async () => {
    const { guarded } = setup([commentTool()])
    const result = await guarded[0].execute(
      { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'THREAD' },
      signal,
    )
    expect(result.isError).toBe(true)
  })

  it('counts successful inline comments', async () => {
    const { guarded, state } = setup([commentTool()])
    await guarded[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'FILE' }, signal)
    expect(state.inlineCommentsAttempted).toBe(1)
    expect(state.inlineCommentsAdded).toBe(1)
  })
})

describe('schema restriction', () => {
  it('restricts pull_request_read method enum', () => {
    const schema = { type: 'object', properties: { method: { type: 'string', enum: ['get', 'get_comments'] } } }
    const { guarded } = setup([tool('pull_request_read', schema)])
    const parameters = guarded[0].spec().parameters
    const method = (parameters.properties as Record<string, Record<string, unknown>>).method
    expect(method.enum).toEqual(['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs'])
  })

  it('appends the guard description to get_file_contents', () => {
    const { guarded } = setup([tool('get_file_contents')])
    expect(guarded[0].spec().description).toContain('PR review guard')
    expect(guarded[0].spec().description).toContain('refs/pull/42/head')
  })
})
