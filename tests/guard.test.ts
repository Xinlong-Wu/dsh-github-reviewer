import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildGuardedToolDefinitions, ReviewGuardState } from '../src/github/guard.ts'
import type { GuardLogger, TurnSlot } from '../src/github/guard.ts'
import type { McpCallOutcome, McpHost, RawMcpTool } from '../src/github/mcp-host.ts'
import type { PullRequest } from '../src/github/model.ts'

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

const silent: GuardLogger = { warn: () => {}, debug: () => {} }
const limits = { maxToolCalls: 30, toolTimeoutMs: 5000 }

function tool(remote: string, inputSchema: Record<string, unknown> = { type: 'object', properties: {} }): RawMcpTool {
  return { name: `mcp_github_${remote}`, description: `description of ${remote}`, inputSchema }
}

interface RecordedCall {
  remote: string
  args: Record<string, unknown>
}

function setup(
  tools: RawMcpTool[],
  hostResult: McpCallOutcome = { content: 'ok', isError: false },
  options: { changedFiles?: string[]; flow?: 'review' | 'chat' } = {},
) {
  const state = new ReviewGuardState()
  const calls: RecordedCall[] = []
  const changedFilesPayload = options.changedFiles === undefined
    ? undefined
    : JSON.stringify(options.changedFiles.map(filename => ({ filename })))
  const host: McpHost = {
    listTools: async () => tools,
    call: async (remote, args) => {
      calls.push({ remote, args })
      if (changedFilesPayload !== undefined && remote === 'pull_request_read' && (args as Record<string, unknown>).method === 'get_files') {
        return { content: changedFilesPayload, isError: false }
      }
      return hostResult
    },
    close: async () => {},
  }
  const slot: TurnSlot = { current: { pr, flow: options.flow ?? 'review', state, host } }
  const definitions = buildGuardedToolDefinitions(tools, pr, slot, limits, silent)
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
  return { state, calls, definitions, byName, slot, exec }
}

async function execute(definitions: ToolDefinition[], name: string, args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown> {
  const definition = definitions.find(candidate => candidate.name === name)
  if (definition === undefined) throw new Error(`no definition ${name}`)
  return definition.execute(args, exec)
}

describe('buildGuardedToolDefinitions filtering', () => {
  it('wraps allowed tools with the mcp_github_ prefix', () => {
    const { definitions } = setup([tool('pull_request_read')])
    expect(definitions).toHaveLength(1)
    expect(definitions[0].name).toBe('mcp_github_pull_request_read')
  })

  it('skips non-github and disallowed tools', () => {
    const { definitions } = setup([
      tool('some_other_server_tool'),
      tool('merge_pull_request'),
      tool('pull_request_read'),
    ])
    expect(definitions.map(definition => definition.name)).toEqual(['mcp_github_pull_request_read'])
  })

  it('skips duplicate remote names', () => {
    const { definitions } = setup([tool('pull_request_read'), tool('pull_request_read')])
    expect(definitions).toHaveLength(1)
  })

  it('declares the canonical output schema and a text renderer', () => {
    const { definitions } = setup([tool('pull_request_read')])
    const definition = definitions[0]
    expect(definition.output.schema).toMatchObject({ type: 'object' })
    const rendered = definition.output.render({}, { content: [{ type: 'text', text: 'hello' }] })
    expect(rendered).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('pull_request_read guard', () => {
  it('allows get/get_diff/get_files/get_status/get_check_runs on the current PR', async () => {
    const { definitions, calls, exec } = setup([tool('pull_request_read')])
    for (const method of ['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs']) {
      const value = await execute(definitions, 'mcp_github_pull_request_read', { owner: 'owner', repo: 'repo', pullNumber: 42, method }, exec)
      expect(value).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    }
    expect(calls).toHaveLength(5)
  })

  it('rejects disallowed read methods', async () => {
    const { definitions, calls, exec } = setup([tool('pull_request_read')])
    await expect(execute(definitions, 'mcp_github_pull_request_read', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get_comments' }, exec))
      .rejects.toThrow('not allowed')
    expect(calls).toHaveLength(0)
  })

  it('rejects calls targeting another PR', async () => {
    const { definitions, exec } = setup([tool('pull_request_read')])
    await expect(execute(definitions, 'mcp_github_pull_request_read', { owner: 'owner', repo: 'repo', pullNumber: 43, method: 'get' }, exec))
      .rejects.toThrow('must target current PR')
  })
})

describe('get_file_contents guard', () => {
  it('defaults sha to head when omitted and allows base/head repos', async () => {
    const { definitions, calls, exec } = setup([tool('get_file_contents')])
    await execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'a.ts' }, exec)
    expect(calls[0].args.sha).toBe('head-sha')
    expect(calls[0].args.ref).toBeUndefined()
  })

  it('rejects third-party repositories', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')])
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'other', repo: 'repo', path: 'a.ts' }, exec))
      .rejects.toThrow('base/head repositories')
  })

  it('rejects passing both sha and ref', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')])
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'a.ts', sha: 'head-sha', ref: 'main' }, exec))
      .rejects.toThrow('both sha and ref')
  })

  it('rejects SHAs that are not the base or head SHA', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')])
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'a.ts', sha: 'main' }, exec))
      .rejects.toThrow('base or head SHA')
  })

  it('allows base branch refs, head branch refs, and refs/pull/N/head', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')], { content: 'ok', isError: false }, { changedFiles: ['a.ts'] })
    for (const [owner, ref] of [
      ['owner', 'main'],
      ['owner', 'refs/heads/main'],
      ['owner', 'refs/pull/42/head'],
      ['forker', 'feature'],
    ] as const) {
      await expect(execute(definitions, 'mcp_github_get_file_contents', { owner, repo: 'repo', path: 'a.ts', ref }, exec), `ref ${ref} on ${owner}`).resolves.toBeDefined()
    }
  })

  it('rejects the head branch ref on the base repo', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')])
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'a.ts', ref: 'feature' }, exec))
      .rejects.toThrow()
  })
})

describe('get_file_contents base-side path scoping', () => {
  it('allows base-side reads only for files changed by the PR', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')], { content: 'ok', isError: false }, { changedFiles: ['src/a.ts', 'README.md'] })
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'src/a.ts', ref: 'main' }, exec))
      .resolves.toBeDefined()
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: '.env', ref: 'main' }, exec))
      .rejects.toThrow('limited to files changed by the current PR')
  })

  it('scopes base SHA reads the same way, but leaves head-side reads unrestricted', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')], { content: 'ok', isError: false }, { changedFiles: ['src/a.ts'] })
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: '.env', sha: 'base-sha' }, exec))
      .rejects.toThrow('limited to files changed by the current PR')
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: '.env', sha: 'head-sha' }, exec))
      .resolves.toBeDefined()
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'forker', repo: 'repo', path: '.env', sha: 'head-sha' }, exec))
      .resolves.toBeDefined()
  })

  it('requires an explicit path for base-side reads', async () => {
    const { definitions, exec } = setup([tool('get_file_contents')], { content: 'ok', isError: false }, { changedFiles: ['src/a.ts'] })
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', ref: 'main' }, exec))
      .rejects.toThrow('requires an explicit path')
  })

  it('fails closed when the changed-file list cannot be fetched', async () => {
    const { definitions, state, exec } = setup([tool('get_file_contents')], { content: 'not json', isError: false })
    await expect(execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'src/a.ts', ref: 'main' }, exec))
      .rejects.toThrow('changed-file list')
    expect(state.changedFilesFailed).toBe(true)
  })

  it('fetches the changed-file list only once per turn', async () => {
    const { definitions, calls, exec } = setup([tool('get_file_contents')], { content: 'ok', isError: false }, { changedFiles: ['src/a.ts'] })
    await execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'src/a.ts', ref: 'main' }, exec)
    await execute(definitions, 'mcp_github_get_file_contents', { owner: 'owner', repo: 'repo', path: 'src/a.ts', sha: 'base-sha' }, exec)
    const fetches = calls.filter(call => call.remote === 'pull_request_read')
    expect(fetches).toHaveLength(1)
    expect(fetches[0].args).toMatchObject({ method: 'get_files', perPage: 100 })
  })
})

describe('chat flow restrictions', () => {
  it('rejects write tools during /bot chat turns', async () => {
    const { definitions, exec } = setup([tool('pull_request_review_write'), tool('add_comment_to_pending_review')], { content: 'ok', isError: false }, { flow: 'chat' })
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create' }, exec))
      .rejects.toThrow('not available during /bot chat turns')
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'x', subjectType: 'FILE' }, exec))
      .rejects.toThrow('not available during /bot chat turns')
  })

  it('still allows read tools during chat turns', async () => {
    const { definitions, exec } = setup([tool('pull_request_read')], { content: 'ok', isError: false }, { flow: 'chat' })
    await expect(execute(definitions, 'mcp_github_pull_request_read', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get' }, exec))
      .resolves.toBeDefined()
  })
})

describe('pull_request_review_write guard', () => {
  it('injects commitID and drops event/body/extra args on create', async () => {
    const { definitions, calls, exec } = setup([tool('pull_request_review_write')])
    await execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', event: 'APPROVE', body: 'x', note: 'y' }, exec)
    expect(calls[0].args).toEqual({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'head-sha' })
  })

  it('accepts the exact head SHA as commitID on create', async () => {
    const { definitions, calls, exec } = setup([tool('pull_request_review_write')])
    await execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'head-sha' }, exec)
    expect(calls[0].args.commitID).toBe('head-sha')
  })

  it('rejects a wrong commitID on create', async () => {
    const { definitions, exec } = setup([tool('pull_request_review_write')])
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create', commitID: 'other' }, exec))
      .rejects.toThrow('commitID must be current PR head SHA')
  })

  it('rejects unknown review write methods', async () => {
    const { definitions, exec } = setup([tool('pull_request_review_write')])
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'dismiss' }, exec))
      .rejects.toThrow('is not allowed')
  })

  it('rejects submit_pending without event=COMMENT', async () => {
    const { definitions, exec } = setup([tool('pull_request_review_write')])
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'APPROVE' }, exec))
      .rejects.toThrow('event=COMMENT')
  })

  it('marks submittedComment only after a successful COMMENT submit', async () => {
    const { definitions, state, exec } = setup([tool('pull_request_review_write')])
    await execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' }, exec)
    expect(state.submittedComment).toBe(true)
    expect(state.submitAttempted).toBe(true)
  })

  it('drops extra keys and redacts secret-looking strings in the submit body', async () => {
    const { definitions, calls, exec } = setup([tool('pull_request_review_write')])
    await execute(definitions, 'mcp_github_pull_request_review_write', {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
      method: 'submit_pending',
      event: 'COMMENT',
      body: 'found ghp_abcdefghijklmnopqrstuvwxyz leaked',
      extra: 'smuggled',
    }, exec)
    expect(calls[0].args.extra).toBeUndefined()
    expect(calls[0].args.body).toBe('found [REDACTED_SECRET] leaked')
  })

  it('does not mark the pending review as created when create fails', async () => {
    const { definitions, state, exec } = setup([tool('pull_request_review_write')], { content: 'nope', isError: true })
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create' }, exec))
      .rejects.toThrow('nope')
    expect(state.pendingReviewCreated).toBe(false)
  })

  it('throws when the MCP server reports an error, without marking submission', async () => {
    const { definitions, state, exec } = setup([tool('pull_request_review_write')], { content: 'boom', isError: true })
    await expect(execute(definitions, 'mcp_github_pull_request_review_write', { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' }, exec))
      .rejects.toThrow('boom')
    expect(state.submittedComment).toBe(false)
  })

  it('enforces the maxToolCalls budget across all tools', async () => {
    const { exec } = setup([tool('pull_request_read')])
    const strict = buildGuardedToolDefinitions([tool('pull_request_read')], pr, {
      current: {
        pr,
        flow: 'review',
        state: new ReviewGuardState(),
        host: {
          listTools: async () => [],
          call: async () => ({ content: 'ok', isError: false }),
          close: async () => {},
        },
      },
    }, { ...limits, maxToolCalls: 1 }, silent)
    const definition = strict[0]
    await definition.execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get' }, exec)
    await expect(definition.execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get' }, exec))
      .rejects.toThrow('max_tool_calls limit')
  })

  it('throws when no turn is active', async () => {
    const slot: TurnSlot = {}
    const definitions = buildGuardedToolDefinitions([tool('pull_request_read')], pr, slot, limits, silent)
    await expect(definitions[0].execute({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'get' }, {
      signal: new AbortController().signal,
    } as unknown as ToolRunContext)).rejects.toThrow('turn is not active')
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

  it('accepts FILE comments without line/side and counts them', async () => {
    const { definitions, state, exec } = setup([commentTool()])
    await execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'FILE' }, exec)
    expect(state.inlineCommentsAttempted).toBe(1)
    expect(state.inlineCommentsAdded).toBe(1)
  })

  it('rejects FILE comments carrying startLine', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'FILE', startLine: 3 }, exec))
      .rejects.toThrow('startLine is only allowed for LINE comments')
  })

  it('accepts LINE comments with line and side', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3, side: 'RIGHT' }, exec))
      .resolves.toBeDefined()
  })

  it('rejects LINE comments without a line or side', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', side: 'RIGHT' }, exec))
      .rejects.toThrow('line is required')
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3 }, exec))
      .rejects.toThrow('side must be LEFT or RIGHT')
  })

  it('requires startLine and startSide together', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 5, side: 'RIGHT', startLine: 3 }, exec))
      .rejects.toThrow('provided together')
  })

  it('rejects absolute and traversal paths', async () => {
    const { definitions, exec } = setup([commentTool()])
    for (const path of ['/etc/passwd', '../secret', 'a\0b']) {
      await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path, body: 'fix', subjectType: 'FILE' }, exec), path)
        .rejects.toThrow('relative repository path')
    }
  })

  it('rejects unknown subjectType', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'THREAD' }, exec))
      .rejects.toThrow('subjectType must be FILE or LINE')
  })

  it('rejects non-positive or inverted line ranges', async () => {
    const { definitions, exec } = setup([commentTool()])
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 0, side: 'RIGHT' }, exec))
      .rejects.toThrow('positive integer')
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' }, exec))
      .rejects.toThrow('not greater than line')
    await expect(execute(definitions, 'mcp_github_add_comment_to_pending_review', { owner: 'owner', repo: 'repo', pullNumber: 42, path: 'a.ts', body: 'fix', subjectType: 'LINE', line: 3, side: 'RIGHT', startLine: 1, startSide: 'TOP' }, exec))
      .rejects.toThrow('startSide must be LEFT or RIGHT')
  })

  it('redacts secrets in inline comment bodies', async () => {
    const { definitions, calls, exec } = setup([commentTool()])
    await execute(definitions, 'mcp_github_add_comment_to_pending_review', {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 42,
      path: 'a.ts',
      body: 'leaks AKIAIOSFODNN7EXAMPLE here',
      subjectType: 'FILE',
    }, exec)
    expect(calls[0].args.body).toBe('leaks [REDACTED_SECRET] here')
  })
})

describe('schema restriction', () => {
  it('restricts pull_request_read method enum', () => {
    const schema = { type: 'object', properties: { method: { type: 'string', enum: ['get', 'get_comments'] } } }
    const { definitions } = setup([tool('pull_request_read', schema)])
    const parameters = definitions[0].parameters as Record<string, unknown>
    const method = (parameters.properties as Record<string, Record<string, unknown>>).method
    expect(method.enum).toEqual(['get', 'get_diff', 'get_files', 'get_status', 'get_check_runs'])
  })

  it('appends the guard description to get_file_contents', () => {
    const { definitions } = setup([tool('get_file_contents')])
    expect(definitions[0].description).toContain('PR review guard')
    expect(definitions[0].description).toContain('refs/pull/42/head')
  })
})
