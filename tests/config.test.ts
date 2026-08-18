import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_LIMIT,
  DEFAULT_TOOL_TIMEOUT_MS,
  normalizeAccountConfig,
  validateAccountRuntime,
} from '../src/config.ts'
import type { AccountConfig } from '../src/config.ts'

const base: AccountConfig = {
  appId: ' 123 ',
  installationId: '456',
  privateKeyPath: '/x.pem',
  baseUrl: 'https://api.github.com/',
  webUrl: 'https://github.com/',
  pollIntervalMs: 5000,
  repositories: [' owner/repo '],
  provider: ' deepseek ',
  model: 'deepseek-chat',
  statePath: ' ./state.json ',
}

describe('normalizeAccountConfig', () => {
  it('materializes review and mcp defaults when omitted and trims strings', () => {
    const normalized = normalizeAccountConfig(base)
    expect(normalized.appId).toBe('123')
    expect(normalized.baseUrl).toBe('https://api.github.com')
    expect(normalized.webUrl).toBe('https://github.com')
    expect(normalized.statePath).toBe('./state.json')
    expect(normalized.review).toEqual({
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      toolResultLimit: DEFAULT_TOOL_RESULT_LIMIT,
      timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
      defaultInstructions: '',
    })
    expect(normalized.mcp).toEqual({ command: '', args: [], env: {}, cwd: '' })
  })

  it('keeps partial review overrides and defaults the rest', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      review: { maxToolCalls: 5, defaultInstructions: '  be careful  ' },
    } as AccountConfig)
    expect(normalized.review.maxToolCalls).toBe(5)
    expect(normalized.review.defaultInstructions).toBe('be careful')
    expect(normalized.review.toolTimeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS)
  })

  it('dedupes repositories, drops blanks, and keeps unparseable raw entries', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      repositories: ['owner/repo', 'owner/repo', 'a/b/c', '', 'owner/other'],
    })
    expect(normalized.repositories).toEqual(['owner/repo', 'a/b/c', 'owner/other'])
  })

  it('normalizes mcp env keys and args', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      mcp: {
        command: '  github-mcp-server ',
        args: [' stdio ', '', '--tools=x'],
        env: { ' A ': '1', '': 'dropped', B: ' v ' },
        cwd: ' /tmp ',
      },
    } as AccountConfig)
    expect(normalized.mcp).toEqual({
      command: 'github-mcp-server',
      args: ['stdio', '--tools=x'],
      env: { A: '1', B: ' v ' },
      cwd: '/tmp',
    })
  })

  it('does not change already-normalized values', () => {
    const once = normalizeAccountConfig(base)
    const twice = normalizeAccountConfig({ ...once, review: once.review, mcp: once.mcp } as AccountConfig)
    expect(twice).toEqual(once)
  })
})

describe('validateAccountRuntime', () => {
  it('accepts a fully valid account', () => {
    const normalized = normalizeAccountConfig({ ...base, mcp: { command: 'x', args: ['y'], env: {}, cwd: '' } })
    expect(() => validateAccountRuntime('reviewer', normalized)).not.toThrow()
  })

  it('rejects missing fields loudly', () => {
    const cases: Array<[Partial<AccountConfig>, RegExp]> = [
      [{ installationId: '' }, /installationId is required/],
      [{ privateKeyPath: '' }, /privateKeyPath is required/],
      [{ repositories: [] }, /at least one owner\/repo/],
      [{ repositories: ['not-a-repo'] }, /must be owner\/repo/],
      [{ provider: '' }, /provider is required/],
      [{ model: '' }, /model is required/],
      [{ mcp: { command: '', args: ['x'], env: {}, cwd: '' } }, /mcp\.command is required/],
      [{ mcp: { command: 'x', args: [], env: {}, cwd: '' } }, /mcp\.args is required/],
    ]
    for (const [patch, expected] of cases) {
      const normalized = normalizeAccountConfig({ ...base, ...patch } as AccountConfig)
      expect(() => validateAccountRuntime('reviewer', normalized), String(expected)).toThrow(expected)
    }
  })

  it('leaves empty optional URLs untouched — schema defaults apply at load', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      baseUrl: '',
      webUrl: '',
    })
    expect(normalized.baseUrl).toBe('')
    expect(normalized.webUrl).toBe('')
    expect(normalized.pollIntervalMs).toBe(base.pollIntervalMs)
  })
})
