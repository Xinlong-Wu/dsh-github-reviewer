/**
 * Review and chat orchestration: drives one model conversation with the
 * guarded GitHub tools through the harness `llm` service, collecting the
 * assistant text and write-tracking state that decide cursor advancement and
 * comment replies. Ported from LingoBridge's review handler.
 * @module
 */

import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolCallBlock,
} from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GuardedTool, GuardLogger, ReviewGuardState } from './github/guard.ts'
import type { PullRequest } from './github/model.ts'
import { buildChatSystemPrompt, buildReviewSystemPrompt, buildReviewUserPrompt } from './github/prompts.ts'
import type { StoredMessage } from './session-store.ts'

/** The one LLM capability this module needs: the streaming call API. */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Per-turn tool execution limits, resolved from account config. */
export interface ReviewOptions {
  /** Maximum tool calls executed across the whole review conversation. */
  maxToolCalls: number
  /** Per-tool-call timeout in milliseconds. */
  toolTimeoutMs: number
  /** Maximum characters of tool result returned to the model per call. */
  toolResultLimit: number
  /** Overall deadline for the whole review conversation in milliseconds. */
  timeoutMs: number
}

/** Logger interface for the orchestrator. */
export interface OrchestratorLogger extends GuardLogger {
  info(message: string): void
  error(message: string): void
}

/** One completed model turn: emitted blocks and finish kind. */
interface TurnOutcome {
  /** Assistant blocks assembled from the stream. */
  blocks: ContentBlock[]
  /** Tool calls requested in this turn. */
  toolCalls: ToolCallBlock[]
  /** Terminal finish reason, when the stream ended. */
  finished: boolean
  /** The finish `kind` when finished. */
  finishKind?: string
}

/** Context of one model conversation. */
export interface ConversationInput {
  /** Model route and id. */
  provider: string
  model: string
  /** System prompt. */
  system: string
  /** First user message. */
  userText: string
  /** Guarded tools exposed to the model. */
  tools: GuardedTool[]
  /** Turn limits. */
  options: ReviewOptions
  /** Overall cancellation. */
  signal: AbortSignal
  /** Replayed per-PR session history, in order, before the current message. */
  history: StoredMessage[]
}

/**
 * Execute one review or chat conversation against the harness LLM service.
 * Write tracking lives on the shared guard state carried by the guarded
 * tools; this function returns the collected assistant text.
 * @param llm - harness LLM runtime.
 * @param input - conversation inputs.
 * @param logger - diagnostics observer.
 * @returns collected assistant text across all turns.
 */
export async function runConversation(
  llm: LlmStreamer,
  input: ConversationInput,
  logger: OrchestratorLogger,
): Promise<string> {
  if (input.signal.aborted) return ''
  const deadline = Date.now() + input.options.timeoutMs
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  input.signal.addEventListener('abort', abort, { once: true })
  const deadlineTimer = setTimeout(abort, input.options.timeoutMs)
  deadlineTimer.unref()
  try {
    return await runWithSignal(llm, input, logger, controller.signal, deadline)
  } finally {
    clearTimeout(deadlineTimer)
    input.signal.removeEventListener('abort', abort)
  }
}

async function runWithSignal(
  llm: LlmStreamer,
  input: ConversationInput,
  logger: OrchestratorLogger,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  const messages: Message[] = [
    ...input.history.map(message => message.role === 'assistant'
      ? createAssistantMessage({
        source: { provider: input.provider, model: input.model },
        content: [{ type: 'text', text: message.text }],
      })
      : createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: message.text }] })),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.userText }] }),
  ]
  let executedCalls = 0
  let collected = ''

  for (;;) {
    if (signal.aborted) return collected
    if (Date.now() >= deadline) {
      logger.warn('github review conversation exceeded its overall timeout')
      return collected
    }
    const outcome = await streamTurn(llm, input, messages, signal, logger)
    messages.push(createAssistantMessage({
      source: { provider: input.provider, model: input.model },
      content: outcome.blocks,
    }))
    for (const block of outcome.blocks) {
      if (block.type === 'text') collected += block.text
    }
    if (outcome.finished && outcome.finishKind !== 'tool-calls') {
      if (outcome.finishKind === 'error' || outcome.finishKind === 'aborted') {
        logger.warn(`github review model call ended with ${outcome.finishKind}`)
      }
      return collected
    }
    if (outcome.toolCalls.length === 0) return collected

    for (const call of outcome.toolCalls) {
      if (executedCalls >= input.options.maxToolCalls) {
        logger.warn(`github review hit the max_tool_calls limit (${input.options.maxToolCalls})`)
        return collected
      }
      const tool = input.tools.find(candidate => candidate.spec().name === call.name)
      let args: Record<string, unknown>
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be a JSON object')
      } catch (error) {
        messages.push(createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: `parse arguments: ${String(error)}` }],
          isError: true,
        }))
        executedCalls++
        continue
      }
      if (tool === undefined) {
        messages.push(createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: `tool ${call.name} is not available for automated PR review` }],
          isError: true,
        }))
        executedCalls++
        continue
      }
      const callSignal = AbortSignal.timeout(input.options.toolTimeoutMs)
      const result = await tool.execute(args, callSignal)
      messages.push(createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: result.content }],
        isError: result.isError,
      }))
      executedCalls++
    }
  }
}

/** Stream one model turn and assemble its blocks. */
async function streamTurn(
  llm: LlmStreamer,
  input: ConversationInput,
  messages: Message[],
  signal: AbortSignal,
  logger: OrchestratorLogger,
): Promise<TurnOutcome> {
  if (signal.aborted) return { blocks: [], toolCalls: [], finished: true, finishKind: 'aborted' }
  const chunks = llm.stream({
    provider: input.provider,
    model: input.model,
    messages,
    system: input.system,
    tools: input.tools.map(tool => tool.spec()),
    signal,
  })
  const blocks: ContentBlock[] = []
  const toolCalls: ToolCallBlock[] = []
  let finished = false
  let finishKind: string | undefined
  try {
    for await (const chunk of chunks) {
      switch (chunk.type) {
        case 'block-end': {
          blocks.push(chunk.block)
          if (chunk.block.type === 'tool-call') toolCalls.push(chunk.block)
          break
        }
        case 'finish': {
          finished = true
          finishKind = chunk.reason.kind
          break
        }
        default:
          break
      }
    }
  } catch (error) {
    logger.error(`github review model stream failed: ${String(error)}`)
    finished = true
    finishKind = 'error'
  }
  return { blocks, toolCalls, finished, finishKind }
}

/**
 * Run one automated review conversation for a PR.
 * @param llm - harness LLM runtime.
 * @param pr - the PR under review.
 * @param instructions - trusted review instructions.
 * @param provider - model provider route.
 * @param model - model id.
 * @param tools - guarded tools.
 * @param options - turn limits.
 * @param state - shared guard state.
 * @param logger - diagnostics observer.
 * @param signal - overall cancellation.
 * @param history - replayed per-PR session history.
 * @returns whether a COMMENT review was submitted and the collected assistant text.
 */
export async function runReview(
  llm: LlmStreamer,
  pr: PullRequest,
  instructions: { text: string; source: string },
  provider: string,
  model: string,
  tools: GuardedTool[],
  options: ReviewOptions,
  state: ReviewGuardState,
  logger: OrchestratorLogger,
  signal: AbortSignal,
  history: StoredMessage[],
): Promise<{ submitted: boolean; text: string }> {
  const text = await runConversation(
    llm,
    {
      provider,
      model,
      system: buildReviewSystemPrompt(pr, instructions),
      userText: buildReviewUserPrompt(pr),
      tools,
      options,
      signal,
      history,
    },
    logger,
  )
  return { submitted: state.submittedComment, text }
}

/**
 * Run one `/bot` chat conversation for a PR and collect the reply text.
 * @param llm - harness LLM runtime.
 * @param pr - the PR under discussion.
 * @param message - sanitized user message.
 * @param provider - model provider route.
 * @param model - model id.
 * @param tools - guarded tools.
 * @param options - turn limits.
 * @param logger - diagnostics observer.
 * @param signal - overall cancellation.
 * @param history - replayed per-PR session history.
 * @returns the reply text, or the empty string when nothing was produced.
 */
export async function runChat(
  llm: LlmStreamer,
  pr: PullRequest,
  message: string,
  provider: string,
  model: string,
  tools: GuardedTool[],
  options: ReviewOptions,
  logger: OrchestratorLogger,
  signal: AbortSignal,
  history: StoredMessage[],
): Promise<string> {
  const text = await runConversation(
    llm,
    {
      provider,
      model,
      system: buildChatSystemPrompt(pr),
      userText: message,
      tools,
      options,
      signal,
      history,
    },
    logger,
  )
  return text.trim()
}
