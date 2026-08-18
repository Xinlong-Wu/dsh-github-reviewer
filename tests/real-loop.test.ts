import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AgentRunner } from '../src/agent-runner.ts'
import type { ResolvedAccountConfig } from '../src/config.ts'
import type { McpHost, RawMcpTool } from '../src/github/mcp-host.ts'
import type { PullRequest } from '../src/github/model.ts'
import { silentLogger } from '../src/logger.ts'

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
  review: { maxToolCalls: 30, toolTimeoutMs: 5000, toolResultLimit: 60000, timeoutMs: 60_000, defaultInstructions: '' },
  mcp: { command: 'github-mcp-server', args: ['stdio'], env: {}, cwd: '' },
  statePath: '',
}

const rawTools: RawMcpTool[] = [
  { name: 'mcp_github_pull_request_read', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_get_file_contents', description: 'file', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_pull_request_review_write', description: 'write', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp_github_add_comment_to_pending_review', description: 'comment', inputSchema: { type: 'object', properties: {} } },
]

const toolCallChunks = (index: number, id: string, name: string, argumentsText: string): StreamChunk[] => [
  { type: 'block-start', index, blockType: 'tool-call' },
  { type: 'tool-call-delta', index, id: CallId(id), name, argumentsDelta: argumentsText },
  { type: 'block-end', index, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText } },
]

const textChunks = (index: number, value: string): StreamChunk[] => [
  { type: 'block-start', index, blockType: 'text' },
  { type: 'text-delta', index, text: value },
  { type: 'block-end', index, block: { type: 'text', text: value } },
]

/** Adapters emit usage before the terminal finish. */
const finish = (kind: 'stop' | 'tool-calls'): StreamChunk[] => [
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind } },
]

function streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Assemble the minimal real harness service spine for the agent loop. */
async function composeSpine(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(TypertRegistry),
    ctx.plugin(AgentRegistry),
    ctx.plugin(SessionStore),
    ctx.plugin(LlmRuntime),
    ctx.plugin(SystemPrompt),
    ctx.plugin(ToolRuntime),
    ctx.plugin(AgentLoop, { agents: [] }),
  ]
  await fibers[fibers.length - 1]
  return {
    ctx,
    dispose: async () => {
      await Promise.all(fibers.map(async fiber => fiber.dispose()))
    },
  }
}

/** A real `LlmAdapter` subclass playing scripted turns. */
class ScriptedAdapter extends LlmAdapter {
  constructor(
    private readonly turns: (() => StreamChunk[])[],
    private readonly onStream?: (options: GenerateOptions) => void,
  ) {
    super()
  }

  private index = 0

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onStream?.(options)
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)] ?? []
    this.index++
    return streamOf(turn()) as never
  }
}

describe('AgentRunner against the real harness agent loop', () => {
  it('drives a full review turn: complete system prompt, guarded tool, session log, submitted state', async () => {
    const { ctx, dispose } = await composeSpine()
    try {
      const seen: GenerateOptions[] = []
      const mcpCalls: Array<{ remote: string; args: Record<string, unknown> }> = []
      ctx.llm.registerAdapter(['deepseek'], new ScriptedAdapter(
        [
          () => [
            ...toolCallChunks(0, 'c1', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' })),
            ...finish('tool-calls'),
          ],
          () => [...textChunks(0, 'Reviewed.'), ...finish('stop')],
        ],
        options => seen.push(options),
      ))

      const runner = new AgentRunner({
        accountName: 'reviewer',
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        tokenSource: { token: async () => 'tok' },
        logger: silentLogger(),
        hostFactory: async () => ({
          listTools: async () => rawTools,
          call: async (remote, args) => {
            mcpCalls.push({ remote, args })
            return { content: 'ok', isError: false }
          },
          close: async () => {},
        } satisfies McpHost),
      })

      const outcome = await runner.driveReview(pr, { text: 'Check security first.', source: 'owner/repo@main' }, new AbortController().signal)

      // The complete review system prompt reached the model.
      expect(seen).toHaveLength(2)
      expect(seen[0].system).toContain('Check security first.')
      expect(seen[0].system).toContain('Trust boundary')
      // The review user prompt was the turn's user message.
      expect(seen[0].messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text.includes('<pull_request>')))).toBe(true)
      // The guarded write tool ran with validated arguments.
      expect(mcpCalls).toEqual([{
        remote: 'pull_request_review_write',
        args: { owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' },
      }])
      // The guard observed the successful COMMENT submit.
      expect(outcome.submitted).toBe(true)
      expect(outcome.text).toBe('Reviewed.')
      // The turn is in the real session log.
      const types = ctx.sessions.list()[0].events.map(event => event.type)
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('tool/call')
      expect(types).toContain('turn/end')

      await runner.dispose()
    } finally {
      await dispose()
    }
  })

  it('rejects a tool call targeting another PR through the real pipeline', async () => {
    const { ctx, dispose } = await composeSpine()
    try {
      ctx.llm.registerAdapter(['deepseek'], new ScriptedAdapter([
        () => [
          ...toolCallChunks(0, 'c1', 'mcp_github_pull_request_read', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 43, method: 'get' })),
          ...finish('tool-calls'),
        ],
        () => [...textChunks(0, 'Stopped.'), ...finish('stop')],
      ]))

      const runner = new AgentRunner({
        accountName: 'reviewer',
        account,
        agents: ctx.agents,
        sessions: ctx.sessions,
        tokenSource: { token: async () => 'tok' },
        logger: silentLogger(),
        hostFactory: async () => ({
          listTools: async () => rawTools,
          call: async () => ({ content: 'ok', isError: false }),
          close: async () => {},
        } satisfies McpHost),
      })

      const outcome = await runner.driveReview(pr, { text: 'trusted', source: 'x' }, new AbortController().signal)
      expect(outcome.submitted).toBe(false)
      // The tool result the model saw carries the guard's rejection.
      const session = ctx.sessions.list()[0]
      const toolResult = session.events.find(event => event.type === 'tool/result')
      expect(toolResult?.type).toBe('tool/result')
      expect(JSON.stringify(toolResult)).toContain('must target current PR')

      await runner.dispose()
    } finally {
      await dispose()
    }
  })
})
