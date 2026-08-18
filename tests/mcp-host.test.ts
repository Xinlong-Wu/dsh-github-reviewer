import { describe, expect, it } from 'vitest'
import { StdioMcpHost } from '../src/github/mcp-host.ts'

/** Minimal JSON-RPC MCP server over stdio, launched as a child process. */
const STUB_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  let result = {};
  if (msg.method === 'initialize') {
    result = {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'stub-mcp', version: '1.0.0' },
    };
  } else if (msg.method === 'tools/list') {
    result = { tools: [
      { name: 'pull_request_read', description: 'read a PR', inputSchema: { type: 'object', properties: { method: { type: 'string' } } } },
      { name: 'get_file_contents', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'no_desc', inputSchema: { type: 'object', properties: {} } },
    ] };
  } else if (msg.method === 'tools/call') {
    const params = msg.params || {};
    if (params.name === 'fail') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } }) + '\n');
      return;
    }
    if (params.name === 'long') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x'.repeat(200) }], isError: false } }) + '\n');
      return;
    }
    result = { content: [{ type: 'text', text: 'ok:' + JSON.stringify(params.arguments || {}) }], isError: false };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
`

const signal = new AbortController().signal

describe('StdioMcpHost against a real MCP server process', () => {
  it('connects, lists tools with the mcp_github_ prefix, and calls them', async () => {
    const host = await StdioMcpHost.connect(
      { command: process.execPath, args: ['-e', STUB_SERVER], env: {}, cwd: '' },
      5000,
      60000,
    )
    try {
      const tools = await host.listTools(signal)
      expect(tools.map(tool => tool.name)).toEqual([
        'mcp_github_pull_request_read',
        'mcp_github_get_file_contents',
        'mcp_github_no_desc',
      ])
      expect(tools[0].inputSchema.properties).toBeDefined()
      // A tool without a description gets the empty string; its schema stays.
      expect(tools[2].description).toBe('')
      expect(tools[2].inputSchema.properties).toEqual({})

      const outcome = await host.call('pull_request_read', { method: 'get' }, signal)
      expect(outcome.isError).toBe(false)
      expect(outcome.content).toBe('ok:{"method":"get"}')
    } finally {
      await host.close()
    }
  })

  it('is idempotent on close', async () => {
    const host = await StdioMcpHost.connect(
      { command: process.execPath, args: ['-e', STUB_SERVER], env: {}, cwd: '' },
      5000,
      60000,
    )
    await host.close()
    await host.close()
  })

  it('propagates an aborted call signal', async () => {
    const host = await StdioMcpHost.connect(
      { command: process.execPath, args: ['-e', STUB_SERVER], env: {}, cwd: '' },
      5000,
      60000,
    )
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(host.call('pull_request_read', {}, controller.signal)).rejects.toThrow()
    } finally {
      await host.close()
    }
  })

  it('surfaces MCP isError results as failed outcomes', async () => {
    const host = await StdioMcpHost.connect(
      { command: process.execPath, args: ['-e', STUB_SERVER], env: {}, cwd: '' },
      5000,
      60000,
    )
    try {
      const outcome = await host.call('fail', {}, signal)
      expect(outcome.isError).toBe(true)
      expect(outcome.content).toContain('nope')
    } finally {
      await host.close()
    }
  })

  it('truncates oversized results to the configured limit', async () => {
    const host = await StdioMcpHost.connect(
      { command: process.execPath, args: ['-e', STUB_SERVER], env: {}, cwd: '' },
      5000,
      20,
    )
    try {
      const outcome = await host.call('long', {}, signal)
      expect(outcome.isError).toBe(false)
      expect(outcome.content).toContain('[tool result truncated]')
      expect(outcome.content.length).toBeLessThanOrEqual(20 + 27) // limit + suffix
    } finally {
      await host.close()
    }
  })

  it('rejects a server that fails to start', async () => {
    await expect(StdioMcpHost.connect(
      { command: 'definitely-not-a-real-command', args: [], env: {}, cwd: '' },
      5000,
      60000,
    )).rejects.toThrow('connect github mcp server')
  })
})
