import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AgentRunner, sessionKey } from '../src/agent-runner.ts'
import type { ResolvedAccountConfig } from '../src/config.ts'
import { StdioMcpHost } from '../src/github/mcp-host.ts'
import type { McpHost, McpServerConfig, RawMcpTool } from '../src/github/mcp-host.ts'
import type { PullRequest } from '../src/github/model.ts'
import { silentLogger } from '../src/logger.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

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
  review: { maxToolCalls: 30, toolTimeoutMs: 5000, toolResultLimit: 60000, timeoutMs: 30_000, defaultInstructions: '', models: [] },
  mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
}

const rawTools: RawMcpTool[] = [
  { name: 'mcp_github_pull_request_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_get_file_contents', description: 'file', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_pull_request_review_write', description: 'write', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_add_comment_to_pending_review', description: 'comment', inputSchema: { type: 'object', properties: {} } },
]

/** A scripted fake agent: followup parks the turn until the test resolves idle. */
function fakeHandle(events: Array<Record<string, unknown>>) {
  const followupMessages: Array<{ content: Array<{ type: string; text?: string }> }> = []
  let resolveIdle: (() => void) | undefined
  const idle = new Promise<void>(resolve => { resolveIdle = resolve })
  const agent = {
    id: 'id',
    options: {},
    session: {
      get seq() {
        return events.length
      },
      events: events as unknown as readonly SessionEvent[],
    },
    inbox: {},
    status: 'idle',
    ctx: {},
    cancel: vi.fn(),
    whenIdle: vi.fn(() => idle),
    followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
      followupMessages.push(message)
    }),
    steer: vi.fn(),
    inject: vi.fn(),
    send: vi.fn(),
    runMaintenance: vi.fn(),
  }
  const handle: AgentHandle & { agent: typeof agent } = {
    agent: agent as never,
    dispose: vi.fn(async () => {}),
  }
  return {
    handle,
    agent,
    followupMessages,
    /** The raw mutable event list backing `agent.session.events`. */
    events,
    resolveTurn(): void {
      resolveIdle?.()
    },
  }
}

interface World {
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  createOptions: unknown[]
  resumeOptions: unknown[]
  sections: Array<{ name: string; order: number; complete?: boolean; text: string | ((context: unknown) => string) }>
  registeredTools: ToolDefinition[]
  fakeHandle: ReturnType<typeof fakeHandle>
  applySetup(): void
  handles: Array<AgentHandle & { agent: never }>
}

function makeWorld(): World {
  const sections: World['sections'] = []
  const registeredTools: ToolDefinition[] = []
  const handles: World['handles'] = []
  const createOptions: unknown[] = []
  const resumeOptions: unknown[] = []
  const fake = fakeHandle([])
  const fakeCtx = {
    systemPrompt: { section: (section: World['sections'][number]) => { sections.push(section) } },
    tools: {
      register: (definition: ToolDefinition) => { registeredTools.push(definition); return () => {} },
      restrict: vi.fn(() => () => {}),
    },
  } as unknown as Context
  const create = vi.fn(async (options: { setup?: (ctx: Context) => void }) => {
    createOptions.push(options)
    options.setup?.(fakeCtx)
    handles.push(fake.handle as never)
    return fake.handle
  })
  const resume = vi.fn(async (options: { setup?: (ctx: Context) => void }) => {
    resumeOptions.push(options)
    options.setup?.(fakeCtx)
    handles.push(fake.handle as never)
    return fake.handle
  })
  return {
    create,
    resume,
    createOptions,
    resumeOptions,
    sections,
    registeredTools,
    fakeHandle: fake,
    applySetup: () => {},
    handles,
  }
}

/** Per-test overrides for {@link makeRunner}. */
interface MakeRunnerOptions {
  /** Account the runner drives with; e.g. a tiny review timeout for deadline tests. */
  account?: ResolvedAccountConfig
  /** MCP host factory override; `null` disables the fake so the real StdioMcpHost.connect is used. */
  hostFactory?: ((token: string, signal: AbortSignal) => Promise<McpHost>) | null
  /** `llm` service mock used by `review.models` resolution. */
  llm?: { listModels(provider: string): Promise<Array<{ id: string }>> }
  /** Session-title service mock. */
  sessionTitle?: {
    get: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
  }
}

function makeRunner(world: World, sessionPersistence?: { listSnapshots: () => Promise<Array<{ header: { id: string } }>> }, options: MakeRunnerOptions = {}) {
  const hosts: Array<{ token: string; closed: boolean }> = []
  const runner = new AgentRunner({
    accountName: 'reviewer',
    account: options.account ?? account,
    agents: {
      create: world.create,
      resume: world.resume,
    } as unknown as AgentRegistry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    ...options.llm === undefined ? {} : { llm: options.llm },
    ...options.sessionTitle === undefined ? {} : { sessionTitle: options.sessionTitle },
    sessions: { flush: vi.fn(async () => true) } as unknown as SessionStore,
    ...sessionPersistence === undefined ? {} : { sessionPersistence: sessionPersistence as never },
    tokenSource: { token: async () => 'tok' },
    logger: silentLogger(),
    ...(options.hostFactory === null
      ? {}
      : {
          hostFactory: options.hostFactory ?? (async (token: string) => {
            const record = { token, closed: false }
            hosts.push(record)
            return {
              listTools: async () => rawTools,
              call: async (_remote, args) => ({ content: JSON.stringify(args), isError: false }),
              close: async () => { record.closed = true },
            } satisfies McpHost
          }),
        }),
  })
  return { runner, hosts }
}

describe('AgentRunner agent lifecycle', () => {
  it('creates one agent per PR and reuses it across review and chat turns', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world)
    const signal = new AbortController().signal

    const reviewPromise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await reviewPromise

    const chatPromise = runner.driveChat(pr, 'what changed?', signal)
    world.fakeHandle.resolveTurn()
    await chatPromise

    expect(world.create).toHaveBeenCalledTimes(1)
    expect(world.resume).not.toHaveBeenCalled()
    expect(world.fakeHandle.agent.followup).toHaveBeenCalledTimes(2)
    expect((world.createOptions[0] as { sessionId: string }).sessionId).toBe('github:reviewer:owner:repo:pr:42')
    expect((world.createOptions[0] as { agentOptions: unknown }).agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    await runner.dispose()
    expect(world.fakeHandle.handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('pins a uniform session title for each PR, once', async () => {
    const world = makeWorld()
    let titled = false
    const get = vi.fn(() => (titled ? { title: 'Review owner/repo PR 42' } : undefined))
    const rename = vi.fn((_session: unknown, _title: string) => { titled = true; return {} })
    const { runner } = makeRunner(world, undefined, { sessionTitle: { get, rename } })
    const signal = new AbortController().signal

    const review1 = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await review1
    const chat = runner.driveChat(pr, 'what changed?', signal)
    world.fakeHandle.resolveTurn()
    await chat

    // Review turn pins the title; the chat turn on the same session skips it.
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith(expect.anything(), 'Review owner/repo PR 42')
    await runner.dispose()
  })

  it('resolves the first available review.model at session creation', async () => {
    const world = makeWorld()
    const llm = {
      listModels: async (provider: string) => {
        if (provider === 'prov-a') return [{ id: 'model-a' }, { id: 'other' }]
        throw new Error(`unknown provider ${provider}`)
      },
    }
    const { runner } = makeRunner(world, undefined, {
      account: { ...account, review: { ...account.review, models: [{ provider: 'prov-a', model: 'model-a' }, { provider: 'prov-b', model: 'model-b' }] } },
      llm,
    })
    const signal = new AbortController().signal

    const reviewPromise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await reviewPromise

    expect((world.createOptions[0] as { agentOptions: unknown }).agentOptions).toEqual({ provider: 'prov-a', model: 'model-a' })
    await runner.dispose()
  })

  it('aborts the review when none of the review.models is available', async () => {
    const world = makeWorld()
    const llm = { listModels: async () => { throw new Error('unknown provider') } }
    const { runner } = makeRunner(world, undefined, {
      account: { ...account, review: { ...account.review, models: [{ provider: 'prov-a', model: 'model-a' }] } },
      llm,
    })
    const signal = new AbortController().signal

    await expect(runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)).rejects.toThrow(
      'none of the configured review.models is available',
    )
    expect(world.create).not.toHaveBeenCalled()
    await runner.dispose()
  })

  it('aborts the review when review.models is configured but the llm service is missing', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world, undefined, {
      account: { ...account, review: { ...account.review, models: [{ provider: 'prov-a', model: 'model-a' }] } },
    })
    const signal = new AbortController().signal

    await expect(runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)).rejects.toThrow(
      'does not mount the llm service',
    )
    expect(world.create).not.toHaveBeenCalled()
    await runner.dispose()
  })

  it('discovers the guarded tool schemas once and reuses them across PRs', async () => {
    const world = makeWorld()
    const { runner, hosts } = makeRunner(world)
    const signal = new AbortController().signal
    const pr2 = { ...pr, number: 43 }

    const review1 = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await review1
    const review2 = runner.driveReview(pr2, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await review2

    expect(world.create).toHaveBeenCalledTimes(2)
    // 1 schema-discovery host + 1 per-turn host per review; without the
    // schema cache there would be a second discovery host (4 total).
    expect(hosts).toHaveLength(3)
    await runner.dispose()
  })

  it('resumes a persisted PR session instead of creating a fresh one', async () => {
    const world = makeWorld()
    const sessionId = 'github:reviewer:owner:repo:pr:42'
    const persistence = { listSnapshots: vi.fn(async () => [{ header: { id: sessionId } }]) }
    const { runner } = makeRunner(world, persistence)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    expect(world.resume).toHaveBeenCalledTimes(1)
    expect(world.create).not.toHaveBeenCalled()
    expect((world.resumeOptions[0] as { resumeSessionId: string }).resumeSessionId).toBe(sessionId)
    await runner.dispose()
  })

  it('creates when persistence knows no such session', async () => {
    const world = makeWorld()
    const persistence = { listSnapshots: vi.fn(async () => [{ header: { id: 'github:reviewer:other:pr:1' } }]) }
    const { runner } = makeRunner(world, persistence)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    expect(world.create).toHaveBeenCalledTimes(1)
    expect(world.resume).not.toHaveBeenCalled()
    await runner.dispose()
  })
})

describe('AgentRunner setup world', () => {
  it('registers a complete system-prompt section and the four guarded tools', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    expect(world.sections).toHaveLength(1)
    expect(world.sections[0]).toMatchObject({ name: 'github-reviewer', order: -100, complete: true })
    expect(world.registeredTools.map(tool => tool.name)).toEqual([
      'mcp_github_pull_request_read',
      'mcp_github_get_file_contents',
      'mcp_github_pull_request_review_write',
      'mcp_github_add_comment_to_pending_review',
    ])
    await runner.dispose()
  })

  it('switches the section text between the review and chat prompts by turn flow', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    const text = world.sections[0].text
    expect(typeof text).toBe('function')
    const provider = text as () => string

    runner.slot.current = {
      pr,
      flow: 'review',
      state: { submittedComment: false, writeAttempted: false, pendingReviewCreated: false, inlineCommentsAttempted: 0, inlineCommentsAdded: 0, submitAttempted: false, toolCallsExecuted: 0 },
      instructions: { text: 'Check security first.', source: 'x' },
      host: {} as McpHost,
    }
    expect(provider()).toContain('Check security first.')

    runner.slot.current = { ...runner.slot.current, flow: 'chat', instructions: undefined }
    expect(provider()).toContain('responding to a comment on GitHub pull request')

    runner.slot.current = undefined
    expect(provider()).toBe('')
    await runner.dispose()
  })
})

describe('AgentRunner turn outcomes', () => {
  it('reports the guard submission state and the summarized assistant text, then clears the slot', async () => {
    const world = makeWorld()
    const { runner, hosts } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    // Wait until the turn preamble finished and the slot is armed.
    await vi.waitFor(() => expect(runner.slot.current).toBeDefined())
    // The turn is parked at whenIdle: simulate the guarded tools and the log.
    runner.slot.current!.state.submittedComment = true
    world.fakeHandle.events.push(
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } } },
    )
    world.fakeHandle.resolveTurn()
    const outcome = await promise

    expect(outcome).toEqual({ submitted: true, text: 'Reviewed.' })
    expect(runner.slot.current).toBeUndefined()
    expect(hosts[hosts.length - 1].closed).toBe(true)
    await runner.dispose()
  })

  it('returns the chat reply text for /bot turns', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveChat(pr, 'what changed?', signal)
    await vi.waitFor(() => expect(runner.slot.current).toBeDefined())
    world.fakeHandle.events.push(
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'The login flow.' }] } } },
    )
    world.fakeHandle.resolveTurn()
    expect(await promise).toBe('The login flow.')
    await runner.dispose()
  })

  it('stays unsubmitted when the turn produced no COMMENT submit', async () => {
    const world = makeWorld()
    const { runner } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    const outcome = await promise
    expect(outcome.submitted).toBe(false)
    await runner.dispose()
  })

  it('injects the installation token into the per-turn MCP host', async () => {
    const world = makeWorld()
    const { runner, hosts } = makeRunner(world)
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    expect(hosts[hosts.length - 1].token).toBe('tok')
    await runner.dispose()
  })
})

describe('AgentRunner session keys', () => {
  it('sanitizes illegal characters out of the account segment', () => {
    expect(sessionKey('my org', pr)).toBe('github:my_org:owner:repo:pr:42')
    expect(sessionKey('a/b:c', pr)).toBe('github:a_b_c:owner:repo:pr:42')
    expect(sessionKey('reviewer', pr)).toBe('github:reviewer:owner:repo:pr:42')
  })
})

describe('AgentRunner turn deadline', () => {
  it('cancels the agent as a user and closes the host when the turn times out', async () => {
    const world = makeWorld()
    const fastAccount: ResolvedAccountConfig = {
      ...account,
      review: { ...account.review, timeoutMs: 50 },
    }
    const { runner, hosts } = makeRunner(world, undefined, { account: fastAccount })
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    // The fake agent never resolves whenIdle on its own; the deadline must fire.
    await vi.waitFor(() => expect(world.fakeHandle.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }))
    // Let the turn unwind past whenIdle.
    world.fakeHandle.resolveTurn()
    const outcome = await promise

    expect(outcome.submitted).toBe(false)
    expect(hosts[hosts.length - 1].closed).toBe(true)
    expect(runner.slot.current).toBeUndefined()
    await runner.dispose()
  })
})

describe('AgentRunner MCP host connection', () => {
  it('passes the installation token and web host to the real StdioMcpHost.connect', async () => {
    const world = makeWorld()
    const fakeHost = {
      listTools: async () => rawTools,
      call: async () => ({ content: '', isError: false }),
      close: async () => {},
    } as unknown as StdioMcpHost
    const connect = vi.spyOn(StdioMcpHost, 'connect').mockResolvedValue(fakeHost)
    // No hostFactory: the runner must use the real connect path.
    const { runner } = makeRunner(world, undefined, { hostFactory: null })
    const signal = new AbortController().signal

    const promise = runner.driveReview(pr, { text: 'trusted', source: 'x' }, signal)
    world.fakeHandle.resolveTurn()
    await promise

    expect(connect).toHaveBeenCalled()
    const lastCall = connect.mock.calls.at(-1)!
    const config = lastCall[0] as McpServerConfig
    expect(config.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('tok')
    expect(config.env.GITHUB_HOST).toBe('https://github.com')
    expect(typeof lastCall[4]).toBe('function')
    await runner.dispose()
  })
})
