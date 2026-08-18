import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import { runChat, runReview } from '../src/review.ts'
import type { LlmStreamer, OrchestratorLogger } from '../src/review.ts'
import { guardReviewTools, ReviewGuardState } from '../src/github/guard.ts'
import type { GuardedTool, GuardLogger } from '../src/github/guard.ts'
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

const options = { maxToolCalls: 30, toolTimeoutMs: 5000, toolResultLimit: 60000, timeoutMs: 60000 }
const signal = new AbortController().signal
const logger: OrchestratorLogger = { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }
const silentGuardLogger: GuardLogger = { warn: () => {}, debug: () => {} }

/** A fake guarded tool that records calls and returns a canned result. */
function fakeTool(name: string, result: { content: string; isError: boolean } = { content: 'done', isError: false }): GuardedTool & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    spec: () => ({ name, description: 'fake', parameters: { type: 'object', properties: {} } }),
    execute: async (args) => {
      calls.push(args)
      return result
    },
  }
}

/** A streamer playing a scripted sequence of turns. */
function scriptedStreamer(turns: StreamChunk[][]): LlmStreamer {
  let index = 0
  return {
    stream: (_options: GenerateOptions): AsyncIterable<StreamChunk> => {
      const chunks = turns[index] ?? []
      index++
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
}

const text = (value: string): StreamChunk => ({ type: 'block-end', index: 0, block: { type: 'text', text: value } })
const toolCall = (id: string, name: string, args: string): StreamChunk => ({
  type: 'block-end',
  index: 1,
  block: { type: 'tool-call', id: CallId(id), name, arguments: args },
})
const stop = (): StreamChunk => ({ type: 'finish', reason: { kind: 'stop' } })
const moreTools = (): StreamChunk => ({ type: 'finish', reason: { kind: 'tool-calls' } })

describe('runReview', () => {
  it('collects text and stops at a clean finish', async () => {
    const llm = scriptedStreamer([[text('No actionable issues found.'), stop()]])
    const state = new ReviewGuardState()
    const tools: GuardedTool[] = []
    const submitted = await runReview(
      llm,
      pr, { text: 'instructions', source: 'x' }, 'deepseek', 'deepseek-chat', tools, options, state, logger, signal,
    )
    expect(submitted).toBe(false)
  })

  it('executes tool calls across turns and submits a COMMENT review', async () => {
    const calls: Array<Record<string, unknown>> = []
    const state = new ReviewGuardState()
    const writeTool = guardReviewTools(
      [{ name: 'mcp_github_pull_request_review_write', description: 'write', inputSchema: { type: 'object', properties: {} } }],
      pr,
      state,
      {
        call: async (_remote, args) => {
          calls.push(args)
          return { content: 'ok', isError: false }
        },
      },
      silentGuardLogger,
    )[0]
    const llm = scriptedStreamer([
      [toolCall('c1', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'create' })), moreTools()],
      [toolCall('c2', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' })), moreTools()],
      [text('Done.'), stop()],
    ])
    const submitted = await runReview(
      llm,
      pr, { text: 'i', source: 'x' }, 'deepseek', 'deepseek-chat', [writeTool], options, state, logger, signal,
    )
    expect(calls).toHaveLength(2)
    expect(state.submittedComment).toBe(true)
    expect(submitted).toBe(true)
  })

  it('does not submit when the submit tool call fails', async () => {
    const writeTool = fakeTool('mcp_github_pull_request_review_write', { content: 'boom', isError: true })
    const llm = scriptedStreamer([
      [toolCall('c1', 'mcp_github_pull_request_review_write', JSON.stringify({ owner: 'owner', repo: 'repo', pullNumber: 42, method: 'submit_pending', event: 'COMMENT' })), moreTools()],
      [text('failed'), stop()],
    ])
    const state = new ReviewGuardState()
    const submitted = await runReview(
      llm,
      pr, { text: 'i', source: 'x' }, 'deepseek', 'deepseek-chat', [writeTool], options, state, logger, signal,
    )
    expect(submitted).toBe(false)
  })

  it('stops executing tools at maxToolCalls', async () => {
    const tool = fakeTool('mcp_github_pull_request_read')
    const llm = scriptedStreamer([
      [toolCall('c1', 'mcp_github_pull_request_read', '{}'), moreTools()],
      [toolCall('c2', 'mcp_github_pull_request_read', '{}'), moreTools()],
    ])
    const limited = { ...options, maxToolCalls: 1 }
    const state = new ReviewGuardState()
    await runReview(
      llm,
      pr, { text: 'i', source: 'x' }, 'deepseek', 'deepseek-chat', [tool], limited, state, logger, signal,
    )
    expect(tool.calls).toHaveLength(1)
  })

  it('reports tool results with isError when the tool rejects the call', async () => {
    const tool = fakeTool('mcp_github_pull_request_read', { content: 'tool call must target current PR', isError: true })
    const llm = scriptedStreamer([
      [toolCall('c1', 'mcp_github_pull_request_read', '{}'), moreTools()],
      [text('ok'), stop()],
    ])
    const state = new ReviewGuardState()
    await runReview(
      llm,
      pr, { text: 'i', source: 'x' }, 'deepseek', 'deepseek-chat', [tool], options, state, logger, signal,
    )
    expect(tool.calls).toHaveLength(1)
  })
})

describe('runChat', () => {
  it('returns the trimmed assistant text', async () => {
    const llm = scriptedStreamer([[text('  here is the answer  '), stop()]])
    const state = new ReviewGuardState()
    const reply = await runChat(
      llm,
      pr, 'what changed?', 'deepseek', 'deepseek-chat', [], options, logger, signal,
    )
    expect(reply).toBe('here is the answer')
  })

  it('aborts on an external cancellation signal', async () => {
    const controller = new AbortController()
    const llm = scriptedStreamer([
      [{ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }, { type: 'finish', reason: { kind: 'stop' } }],
    ])
    controller.abort()
    const state = new ReviewGuardState()
    const reply = await runChat(
      llm,
      pr, 'hi', 'deepseek', 'deepseek-chat', [], options, logger, controller.signal,
    )
    expect(reply).toBe('')
  })
})

describe('stream error containment', () => {
  it('ends the conversation when the stream throws', async () => {
    const errors = vi.fn()
    const failing = (): AsyncIterable<StreamChunk> => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('provider down')
      },
    })
    const llm: LlmStreamer = { stream: () => failing() }
    const state = new ReviewGuardState()
    const submitted = await runReview(
      llm,
      pr, { text: 'i', source: 'x' }, 'deepseek', 'deepseek-chat', [], options, state, { ...logger, error: errors }, signal,
    )
    expect(submitted).toBe(false)
    expect(errors).toHaveBeenCalled()
  })
})
