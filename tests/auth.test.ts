import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, verify } from 'node:crypto'
import { AppTokenSource, StaticTokenSource, makeAppJWT } from '../src/github/auth.ts'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const NOW = new Date('2026-01-02T03:04:05.000Z')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('makeAppJWT', () => {
  it('produces a compact RS256 JWT with iat backdated and exp in the future', () => {
    const jwt = makeAppJWT('12345', pem, NOW)
    const [headerPart, claimsPart, signaturePart] = jwt.split('.')
    expect(signaturePart).toBeTruthy()
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { alg: string; typ: string }
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString()) as { iat: number; exp: number; iss: string }
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(claims.iss).toBe('12345')
    expect(claims.iat).toBe(Math.floor(NOW.getTime() / 1000) - 60)
    expect(claims.exp).toBe(claims.iat + 9 * 60 + 60)
  })

  it('verifies against the private key', () => {
    const jwt = makeAppJWT('12345', pem, NOW)
    const [headerPart, claimsPart, signaturePart] = jwt.split('.')
    const ok = verify('RSA-SHA256', Buffer.from(`${headerPart}.${claimsPart}`), privateKey, Buffer.from(signaturePart, 'base64url'))
    expect(ok).toBe(true)
  })

  it('requires an app id', () => {
    expect(() => makeAppJWT('  ', pem, NOW)).toThrow('app_id is required')
  })
})

describe('AppTokenSource', () => {
  it('caches tokens and refreshes only near expiry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1', expires_at: '2026-01-02T04:00:00Z' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchImpl)
    let clock = NOW
    const source = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => clock)

    // First call mints a token.
    const first = await source.token()
    expect(first).toBe('tok-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Within the refresh window the cached token is reused.
    clock = new Date(NOW.getTime() + 60_000)
    const second = await source.token()
    expect(second).toBe('tok-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Near expiry it refreshes.
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'tok-2', expires_at: '2026-01-02T05:00:00Z' }), { status: 201 }))
    clock = new Date(Date.parse('2026-01-02T03:59:00Z'))
    const third = await source.token()
    expect(third).toBe('tok-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects responses missing a token or expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 201 })))
    const source = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => NOW)
    await expect(source.token()).rejects.toThrow('missing token')
  })

  it('rejects responses missing or mis-dating expires_at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1' }), { status: 201 })))
    const missing = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => NOW)
    await expect(missing.token()).rejects.toThrow('missing expires_at')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1', expires_at: 'not-a-date' }), { status: 201 })))
    const invalid = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => NOW)
    await expect(invalid.token()).rejects.toThrow('missing expires_at')
  })

  it('shares one refresh across concurrent token() calls', async () => {
    let resolveFetch: ((value: Response) => void) | undefined
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchImpl)
    const source = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => NOW)

    const first = source.token()
    const second = source.token()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    resolveFetch?.(new Response(JSON.stringify({ token: 'tok-1', expires_at: '2026-01-02T04:00:00Z' }), { status: 201 }))
    await expect(first).resolves.toBe('tok-1')
    await expect(second).resolves.toBe('tok-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the still-valid cache when a refresh fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'tok-1', expires_at: '2026-01-02T04:00:00Z' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchImpl)
    let clock = NOW
    const source = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => clock)

    // First call mints and caches a token.
    await expect(source.token()).resolves.toBe('tok-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Move into the refresh window (before expiry), then make the refresh fail:
    // the still-valid cache must be returned instead of an error.
    clock = new Date(Date.parse('2026-01-02T03:59:00Z'))
    fetchImpl.mockRejectedValueOnce(new Error('network down'))
    await expect(source.token()).resolves.toBe('tok-1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('surfaces non-2xx responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    const source = new AppTokenSource('12345', '987', pem, 'https://api.github.com', () => NOW)
    await expect(source.token()).rejects.toThrow('status=403')
  })
})

describe('StaticTokenSource', () => {
  it('returns the configured token unchanged', async () => {
    const source = new StaticTokenSource('  github_pat_xxx  ')
    await expect(source.token()).resolves.toBe('github_pat_xxx')
    await expect(source.token()).resolves.toBe('github_pat_xxx')
  })

  it('rejects a blank token', () => {
    expect(() => new StaticTokenSource('   ')).toThrow('personal access token is required')
  })
})
