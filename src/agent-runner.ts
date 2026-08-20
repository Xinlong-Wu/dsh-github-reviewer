/**
 * Agent runner: owns one live harness Agent per PR, created through the
 * agent registry and resumed from session persistence when the PR session
 * already exists. Review and chat turns are driven through the real agent
 * loop (`agent.followup` → `whenIdle`), so the session log is the durable
 * per-PR history and the loop's system-prompt assembly, tool pipeline, and
 * persistence checkpoints all apply.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ResolvedAccountConfig } from './config.ts'
import type { TokenSource } from './github/auth.ts'
import { buildGuardedToolDefinitions, ReviewGuardState } from './github/guard.ts'
import type { TurnSlot } from './github/guard.ts'
import { StdioMcpHost } from './github/mcp-host.ts'
import type { McpHost, RawMcpTool } from './github/mcp-host.ts'
import type { PullRequest, ReviewInstructions } from './github/model.ts'
import { fullName } from './github/model.ts'
import { buildChatSystemPrompt, buildReviewSystemPrompt, buildReviewUserPrompt } from './github/prompts.ts'
import type { PollLogger } from './logger.ts'

/** Runtime dependencies of one account's agent runner. */
export interface AgentRunnerDeps {
  accountName: string
  account: ResolvedAccountConfig
  agents: AgentRegistry
  sessions: SessionStore
  /** Deployment-owned default model selection; every review agent uses it. */
  agentDefaultModel: { currentSelection(): ModelSelection }
  /**
   * Optional `llm` service (mounted by the base bundle). Needed only when
   * `review.models` is configured: the first available candidate is resolved
   * at session creation, not at plugin mount, so a bad list never blocks boot.
   */
  llm?: {
    /** Models advertised by one registered provider route, in catalog order. */
    listModels(provider: string): Promise<Array<{ id: string }>>
  }
  /**
   * Optional harness session-title service; when mounted, every PR session is
   * renamed to a uniform `Review <owner>/<repo> PR <number>` title (pinned, so
   * automatic generation never overrides it).
   */
  sessionTitle?: {
    get(session: { id: string; events: readonly unknown[] }): { title?: string } | undefined
    rename(session: { id: string; events: readonly unknown[] }, title: string): unknown
  }
  /** Durable session storage; absent in compositions without a persistence provider. */
  sessionPersistence?: SessionPersistence
  /** Non-blocking notification after one reviewer session is live or resumed. */
  onSessionReady?: (sessionId: SessionId) => void
  tokenSource: TokenSource
  logger: PollLogger
  /** Optional MCP host factory override, for tests. */
  hostFactory?: (token: string, signal: AbortSignal) => Promise<McpHost>
}

/** Outcome of one driven review turn. */
export interface ReviewTurnOutcome {
  /** Whether a COMMENT review was submitted through the guarded tools. */
  submitted: boolean
  /** The turn's final assistant text, for logs. */
  text: string
}

/** Stable session key for one PR: account-scoped, repo and PR number based. */
export function sessionKey(accountName: string, pr: PullRequest): string {
  const safeAccount = accountName.replace(/[^a-zA-Z0-9_.-]+/g, '_')
  return `github:${safeAccount}:${pr.base.repo.owner}:${pr.base.repo.name}:pr:${pr.number}`
}

/** Aggregate the last assistant text within one owned interval. */
function summarizeInterval(events: readonly SessionEvent[], firstSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
  }
  return text
}

/**
 * One live PR agent plus its owner handle. Review and chat turns on the same
 * PR reuse the handle; disposal tears every handle down.
 */
export class AgentRunner {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly abortController = new AbortController()
  private turnTail: Promise<void> = Promise.resolve()
  private disposed = false
  private disposal: Promise<void> | undefined
  /** Mutable per-turn context read by the guarded tools and the prompt section. */
  readonly slot: TurnSlot = {}

  /**
   * @param deps - runtime dependencies.
   */
  constructor(private readonly deps: AgentRunnerDeps) {}

  /**
   * Drive one review turn for a PR through the agent loop.
   * @param pr - the PR under review.
   * @param instructions - trusted review instructions.
   * @param signal - cancellation for agent creation and the turn deadline.
   * @returns the submission outcome and the turn's final text.
   */
  async driveReview(pr: PullRequest, instructions: ReviewInstructions, signal: AbortSignal): Promise<ReviewTurnOutcome> {
    return this.enqueueTurn(() => this.driveTurn(pr, 'review', buildReviewUserPrompt(pr), instructions, signal))
  }

  /**
   * Drive one `/bot` chat turn for a PR and return the reply text.
   * @param pr - the PR under discussion.
   * @param message - sanitized user message.
   * @param signal - cancellation for agent creation and the turn deadline.
   * @returns the reply text, or the empty string when nothing was produced.
   */
  async driveChat(pr: PullRequest, message: string, signal: AbortSignal): Promise<string> {
    const outcome = await this.enqueueTurn(() => this.driveTurn(pr, 'chat', message, undefined, signal))
    return outcome.text
  }

  /** Dispose every live PR agent after the active serialized turn settles. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.abortController.abort()
    for (const handle of this.handles.values()) handle.agent.cancel({ kind: 'user' })
    this.disposal = this.turnTail.then(async () => {
      this.slot.current = undefined
      const handles = [...this.handles.values()]
      this.handles.clear()
      for (const handle of handles) await handle.dispose()
    })
    return this.disposal
  }

  /** Queue one turn behind the runner's single mutable guarded-tool slot. */
  private enqueueTurn<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('github reviewer agent runner is disposed'))
    const run = this.turnTail.then(async () => {
      if (this.disposed) throw new Error('github reviewer agent runner is disposed')
      return task()
    })
    this.turnTail = run.then(() => {}, () => {})
    return run
  }

  /** One turn: prepare the slot, wake the agent, await quiescence, flush, summarize. */
  private async driveTurn(
    pr: PullRequest,
    flow: 'review' | 'chat',
    userText: string,
    instructions: ReviewInstructions | undefined,
    signal: AbortSignal,
  ): Promise<ReviewTurnOutcome> {
    const turnSignal = AbortSignal.any([signal, this.abortController.signal])
    // The deadline covers the whole turn, including agent creation and the MCP handshake.
    let agent: AgentHandle['agent'] | undefined
    const cancelAgent = (): void => { agent?.cancel({ kind: 'user' }) }
    turnSignal.addEventListener('abort', cancelAgent, { once: true })
    const deadline = setTimeout(cancelAgent, this.deps.account.review.timeoutMs)
    deadline.unref()
    let host: McpHost | undefined
    const state = new ReviewGuardState()
    let firstSeq = 0
    try {
      const handle = await this.ensureAgent(pr, turnSignal)
      agent = handle.agent
      if (turnSignal.aborted) agent.cancel({ kind: 'user' })
      this.renameSession(agent.session, pr)
      const token = await this.deps.tokenSource.token(turnSignal)
      host = await this.connectHost(token, turnSignal)
      firstSeq = agent.session.seq
      this.slot.current = { pr, flow, state, host, ...instructions === undefined ? {} : { instructions } }
      this.deps.logger.debug(`using shared github pr session repo=${pr.base.repo.owner}/${pr.base.repo.name} number=${pr.number} flow=${flow}`)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    } finally {
      clearTimeout(deadline)
      turnSignal.removeEventListener('abort', cancelAgent)
      this.slot.current = undefined
      if (host !== undefined) await host.close()
    }
    if (agent === undefined) throw new Error('unreachable: turn ended without an agent')
    await this.deps.sessions.flush(agent.session)
    const text = summarizeInterval(agent.session.events, firstSeq)
    return { submitted: state.submittedComment, text }
  }

  /**
   * Pin a uniform session title for one PR, once. The title is user-sourced
   * through the session-title service, so automatic generation never replaces
   * it; already-titled sessions (e.g. resumed from persistence) are skipped.
   */
  private renameSession(session: { id: string; events: readonly unknown[] }, pr: PullRequest): void {
    const service = this.deps.sessionTitle
    if (service === undefined) return
    const title = `Review ${fullName(pr.base.repo)} PR ${pr.number}`
    try {
      if (service.get(session)?.title === title) return
      service.rename(session, title)
    } catch (error) {
      this.deps.logger.warn(`github review session title rename failed: ${String(error)}`)
    }
  }

  /** Return the live handle for a PR, creating or resuming its agent once. */
  private async ensureAgent(pr: PullRequest, signal: AbortSignal): Promise<AgentHandle> {
    const key = sessionKey(this.deps.accountName, pr)
    const sessionId = SessionId(key)
    const live = this.handles.get(key)
    if (live !== undefined) {
      this.deps.onSessionReady?.(sessionId)
      return live
    }

    const toolSchemas = await this.fetchToolSchemas(signal)
    const selection = await this.resolveModel()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      // The review world is a closed tool set, like LingoBridge's guarded-only
      // handler: hide every global tool so the model can reach only the four
      // scoped GitHub tools below (scoped registrations are unaffected by
      // restrictions).
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.systemPrompt.section({
        name: 'github-reviewer',
        order: -100,
        complete: true,
        text: () => this.currentSystemPrompt(),
      })
      const definitions = buildGuardedToolDefinitions(
        toolSchemas,
        pr,
        this.slot,
        {
          maxToolCalls: this.deps.account.review.maxToolCalls,
          toolTimeoutMs: this.deps.account.review.toolTimeoutMs,
        },
        this.deps.logger,
      )
      if (definitions.length === 0) {
        throw new Error('github mcp host exposed no allowed PR review tools')
      }
      for (const definition of definitions) agentCtx.tools.register(definition)
    }

    let handle: AgentHandle
    const persistence = this.deps.sessionPersistence
    if (persistence !== undefined) {
      const snapshots = await persistence.listSnapshots(signal)
      const exists = snapshots.some(snapshot => snapshot.header.id === sessionId)
      handle = exists
        ? await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions, setup, signal })
        : await this.deps.agents.create({
          sessionId,
          meta: { cwd: this.deps.account.workspaceDir },
          agentOptions,
          setup,
          signal,
        })
    } else {
      handle = await this.deps.agents.create({
        sessionId,
        meta: { cwd: this.deps.account.workspaceDir },
        agentOptions,
        setup,
        signal,
      })
    }
    this.handles.set(key, handle)
    this.deps.onSessionReady?.(sessionId)
    return handle
  }

  /**
   * Discover the guarded tool schemas once per process, then reuse them for
   * every PR: the schema depends only on the MCP server (command + args), not
   * on the PR or the token. A failed discovery clears the cache so the next
   * PR retries it.
   */
  private toolSchemas: Promise<RawMcpTool[]> | undefined

  private async fetchToolSchemas(signal: AbortSignal): Promise<RawMcpTool[]> {
    if (this.toolSchemas !== undefined) return this.toolSchemas
    const promise = this.discoverToolSchemas(signal)
    this.toolSchemas = promise
    try {
      return await promise
    } catch (error) {
      this.toolSchemas = undefined
      throw error
    }
  }

  private async discoverToolSchemas(signal: AbortSignal): Promise<RawMcpTool[]> {
    const token = await this.deps.tokenSource.token(signal)
    const host = await this.connectHost(token, signal)
    try {
      return await host.listTools(signal)
    } finally {
      await host.close()
    }
  }

  /**
   * Resolve the review model once per process, at the first session creation:
   * the first `review.models` candidate whose provider is mounted and whose
   * model appears in that provider's catalog wins. A successful resolution is
   * cached; a failure is not, so a later attempt re-checks (and the poller's
   * failure backoff keeps retries apart). With an empty list the deployment
   * default selection is returned.
   * @returns the provider/model pair for review agents.
   * @throws when `review.models` is configured but no candidate is available,
   * or the `llm` service is not mounted.
   */
  private modelSelection: Promise<{ provider: string; model: string }> | undefined

  private resolveModel(): Promise<{ provider: string; model: string }> {
    if (this.modelSelection !== undefined) return this.modelSelection
    const promise = this.discoverModel().catch((error) => {
      this.modelSelection = undefined
      throw error
    })
    this.modelSelection = promise
    return promise
  }

  private async discoverModel(): Promise<{ provider: string; model: string }> {
    const candidates = this.deps.account.review.models
    if (candidates.length === 0) {
      const selection = this.deps.agentDefaultModel.currentSelection()
      return { provider: selection.provider, model: selection.model }
    }
    const llm = this.deps.llm
    if (llm === undefined) {
      throw new Error(
        `github-reviewer.${this.deps.accountName}: review.models is configured but the deployment does not mount the llm service`,
      )
    }
    for (const candidate of candidates) {
      try {
        const models = await llm.listModels(candidate.provider)
        if (models.some(model => model.id === candidate.model)) {
          this.deps.logger.info(
            `github reviewer model resolved account=${this.deps.accountName} provider=${candidate.provider} model=${candidate.model}`,
          )
          return { provider: candidate.provider, model: candidate.model }
        }
      } catch {
        // Unregistered provider or adapter failure: try the next candidate.
      }
    }
    throw new Error(
      `github-reviewer.${this.deps.accountName}: none of the configured review.models is available; `
      + `candidates: ${candidates.map(candidate => `${candidate.provider}/${candidate.model}`).join(', ')}`,
    )
  }

  /** Connect the per-turn MCP server with token and host injected. */
  private async connectHost(token: string, signal: AbortSignal): Promise<McpHost> {
    const factory = this.deps.hostFactory
    if (factory !== undefined) return factory(token, signal)
    const account = this.deps.account
    const env: Record<string, string> = { ...account.mcp.env }
    env.GITHUB_PERSONAL_ACCESS_TOKEN = token
    if (account.webUrl !== '') env.GITHUB_HOST = account.webUrl
    return StdioMcpHost.connect(
      { command: account.mcp.command, args: account.mcp.args, env, cwd: account.mcp.cwd },
      account.review.toolTimeoutMs,
      account.review.toolResultLimit,
      signal,
      line => this.deps.logger.debug(`github mcp server stderr: ${line}`),
    )
  }

  /** The complete system prompt for the turn currently being assembled. */
  private currentSystemPrompt(): string {
    const turn = this.slot.current
    if (turn === undefined) return ''
    if (turn.flow === 'chat') return buildChatSystemPrompt(turn.pr)
    return buildReviewSystemPrompt(turn.pr, turn.instructions ?? { text: '', source: 'unavailable' })
  }
}
