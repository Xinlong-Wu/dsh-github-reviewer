/**
 * Per-review GitHub MCP host: spawns the configured `github-mcp-server` over
 * stdio for one review run, exposes its tools as `mcp_github_<tool>`, and
 * closes the server when the run ends. Ported from LingoBridge's per-review
 * MCP host lifecycle.
 * @module
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { GITHUB_MCP_TOOL_PREFIX } from './guard.ts'

/** One MCP tool as discovered from the server, before guarding. */
export interface RawMcpTool {
  /** Model-facing name with the `mcp_github_` prefix applied. */
  name: string
  description: string
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>
}

/** Spawn parameters for the per-review GitHub MCP server. */
export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** One tool execution result, before the harness pipeline renders it. */
export interface McpCallOutcome {
  /** Text sent back to the model (already bounded). */
  content: string
  isError: boolean
}

/** A live per-review MCP host. */
export interface McpHost {
  /** Discover tools exposed by the server, renamed with the `mcp_github_` prefix. */
  listTools(signal: AbortSignal): Promise<RawMcpTool[]>
  /** Call one remote tool by its name without the prefix. */
  call(remoteName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallOutcome>
  /** Close the server process; idempotent. */
  close(): Promise<void>
}

/** One text output of an MCP call, if any. */
function extractText(content: unknown): { text: string; isError: boolean } {
  if (!Array.isArray(content)) return { text: '', isError: false }
  let text = ''
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
  }
  return { text, isError: false }
}

/** Stdio MCP host for one review run. */
export class StdioMcpHost implements McpHost {
  private readonly client: Client
  private readonly transport: StdioClientTransport
  private closed = false

  /**
   * @param config - server spawn parameters.
   * @param toolTimeoutMs - per-call timeout applied to every MCP request.
   * @param resultLimit - maximum characters returned to the model per call.
   */
  private constructor(
    config: McpServerConfig,
    private readonly toolTimeoutMs: number,
    private readonly resultLimit: number,
  ) {
    this.client = new Client(
      { name: 'dsh-github-reviewer', version: '0.1.0' },
      { capabilities: {} },
    )
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd === '' ? undefined : config.cwd,
      stderr: 'pipe',
    })
  }

  /**
   * Spawn the server and complete the MCP handshake.
   * @param config - server spawn parameters.
   * @param toolTimeoutMs - per-call timeout in milliseconds.
   * @param resultLimit - maximum characters returned to the model per call.
   * @returns a connected host; the caller owns `close()`.
   */
  static async connect(
    config: McpServerConfig,
    toolTimeoutMs: number,
    resultLimit: number,
  ): Promise<StdioMcpHost> {
    const host = new StdioMcpHost(config, toolTimeoutMs, resultLimit)
    try {
      await host.client.connect(host.transport)
    } catch (error) {
      await host.close()
      throw new Error(`connect github mcp server: ${String(error)}`)
    }
    return host
  }

  /**
   * Discover tools exposed by the server.
   * @param signal - cancellation.
   * @returns tools with model-facing `mcp_github_<tool>` names.
   */
  async listTools(signal: AbortSignal): Promise<RawMcpTool[]> {
    const result = await this.client.listTools({}, {
      signal,
      timeout: this.toolTimeoutMs,
      maxTotalTimeout: this.toolTimeoutMs,
    })
    if (!Array.isArray(result.tools)) return []
    const out: RawMcpTool[] = []
    for (const tool of result.tools) {
      if (typeof tool.name !== 'string' || tool.name === '') continue
      out.push({
        name: `${GITHUB_MCP_TOOL_PREFIX}${tool.name}`,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema:
          typeof tool.inputSchema === 'object' && tool.inputSchema !== null && !Array.isArray(tool.inputSchema)
            ? tool.inputSchema as Record<string, unknown>
            : { type: 'object', properties: {} },
      })
    }
    return out
  }

  /**
   * Call one remote tool by its name without the `mcp_github_` prefix.
   * @param remoteName - remote tool name, e.g. `pull_request_read`.
   * @param args - validated JSON arguments.
   * @param signal - per-call cancellation and timeout.
   * @returns text content bounded to the configured result limit.
   */
  async call(remoteName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallOutcome> {
    try {
      const result = await this.client.callTool(
        { name: remoteName, arguments: args },
        CallToolResultSchema,
        { signal, timeout: this.toolTimeoutMs, maxTotalTimeout: this.toolTimeoutMs },
      )
      const extracted = extractText(result.content)
      const rawText = extracted.text
      const isError = extracted.isError || result.isError === true
      const bounded = rawText.length > this.resultLimit
        ? `${rawText.slice(0, this.resultLimit)}\n...[tool result truncated]`
        : rawText
      return { content: bounded, isError }
    } catch (error) {
      if (signal.aborted) throw error
      return { content: `github mcp tool ${remoteName} failed: ${String(error)}`, isError: true }
    }
  }

  /**
   * Close the server process. Idempotent; safe to call after a failed connect.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.close()
    } catch {
      // Transport already gone during a failed connect or a server crash.
    }
  }
}
