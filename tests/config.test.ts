import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_LIMIT,
  DEFAULT_TOOL_TIMEOUT_MS,
  normalizeAccountConfig,
  validateAccountRuntime,
} from '../src/config.ts'
import type { Config as AccountConfig } from '../src/config.ts'

const base: AccountConfig = {
  appId: ' 123 ',
  installationId: '456',
  privateKeyPath: '/x.pem',
  baseUrl: 'https://api.github.com/',
  webUrl: 'https://github.com/',
  pollIntervalMs: 5000,
  repositories: [' owner/repo '],
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('normalizeAccountConfig', () => {
  it('materializes review and mcp defaults when omitted and trims strings', () => {
    const normalized = normalizeAccountConfig(base)
    expect(normalized.appId).toBe('123')
    expect(normalized.baseUrl).toBe('https://api.github.com')
    expect(normalized.webUrl).toBe('https://github.com')
    expect(normalized.uiSettings).toBe(true)
    expect(normalized.review).toEqual({
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      toolResultLimit: DEFAULT_TOOL_RESULT_LIMIT,
      timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
      defaultInstructions: '',
      commandAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      models: [],
    })
    expect(normalized.mcp).toEqual({ command: '', args: [], env: {}, cwd: '' })
  })

  it('keeps an explicit uiSettings opt-out for additional instances', () => {
    expect(normalizeAccountConfig({ ...base, uiSettings: false }).uiSettings).toBe(false)
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

  it('dedupes repositories case-insensitively, drops blanks, and keeps unparseable raw entries', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      repositories: ['owner/repo', 'Owner/Repo', 'a/b/c', '', 'owner/other'],
    })
    expect(normalized.repositories).toEqual(['owner/repo', 'a/b/c', 'owner/other'])
  })

  it('normalizes command author associations to upper case', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      review: { commandAuthorAssociations: [' owner ', '', '*'] },
    } as unknown as AccountConfig)
    expect(normalized.review.commandAuthorAssociations).toEqual(['OWNER', '*'])
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

  it('accepts a personal access token instead of the App credentials', () => {
    const normalized = normalizeAccountConfig({
      appId: '',
      installationId: '',
      privateKeyPath: '',
      personalAccessToken: ' github_pat_xxx ',
      baseUrl: 'https://api.github.com',
      webUrl: 'https://github.com',
      pollIntervalMs: 5000,
      repositories: ['owner/repo'],
      mcp: { command: 'x', args: ['y'], env: {}, cwd: '' },
    } as AccountConfig)
    expect(normalized.personalAccessToken).toBe('github_pat_xxx')
    expect(() => validateAccountRuntime('reviewer', normalized)).not.toThrow()
  })

  it('rejects mixing a personal access token with App credentials', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      personalAccessToken: 'ghp_xxx',
      mcp: { command: 'x', args: ['y'], env: {}, cwd: '' },
    } as AccountConfig)
    expect(() => validateAccountRuntime('reviewer', normalized)).toThrow('mutually exclusive')
  })

  it('accepts an empty repository list as an idle reviewer', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      repositories: [],
      mcp: { command: 'x', args: ['y'], env: {}, cwd: '' },
    } as AccountConfig)
    expect(() => validateAccountRuntime('reviewer', normalized)).not.toThrow()
  })

  it('rejects missing fields loudly', () => {
    const cases: Array<[Partial<AccountConfig>, RegExp]> = [
      [{ installationId: '' }, /installationId is required/],
      [{ privateKeyPath: '' }, /privateKeyPath is required/],
      [{ repositories: ['not-a-repo'] }, /must be owner\/repo/],
      [{ mcp: { command: '', args: ['x'], env: {}, cwd: '' } }, /mcp\.command is required/],
      [{ mcp: { command: 'x', args: [], env: {}, cwd: '' } }, /mcp\.args is required/],
      [{ baseUrl: '', mcp: { command: 'x', args: ['y'], env: {}, cwd: '' } }, /baseUrl is required/],
      [{ baseUrl: 'ftp://example.com', mcp: { command: 'x', args: ['y'], env: {}, cwd: '' } }, /baseUrl must be http\(s\)/],
      [{ webUrl: 'not a url', mcp: { command: 'x', args: ['y'], env: {}, cwd: '' } }, /webUrl is not a valid URL/],
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

  it('defaults the workspace dir under $DSH_HOME and the title to GithubReviewer', () => {
    vi.stubEnv('DSH_HOME', '/dsh')
    const normalized = normalizeAccountConfig(base)
    expect(normalized.workspaceDir).toBe('/dsh/github-reviewer/default')
    expect(normalized.workspaceTitle).toBe('GithubReviewer')
  })

  it('keeps a configured workspace dir and title', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      name: 'org',
      workspaceDir: ' /var/lib/ghr ',
      workspaceTitle: ' GH Reviews ',
    } as AccountConfig)
    expect(normalized.workspaceDir).toBe('/var/lib/ghr')
    expect(normalized.workspaceTitle).toBe('GH Reviews')
  })

  it('normalizes review.models: trims, keeps provider+model pairs, drops blanks', () => {
    const normalized = normalizeAccountConfig({
      ...base,
      review: {
        models: [
          { provider: ' deepseek-official ', model: ' deepseek-v4-flash ' },
          { provider: '', model: 'x' },
          { provider: 'ssct-openai', model: '' },
          { provider: 'ssct-openai', model: 'gpt-5.2' },
        ],
      },
    } as AccountConfig)
    expect(normalized.review.models).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'ssct-openai', model: 'gpt-5.2' },
    ])
  })
})
