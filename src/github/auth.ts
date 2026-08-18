/**
 * GitHub App authentication: RS256 app JWTs and cached installation access
 * tokens. Ported from LingoBridge's app token source; uses Node's built-in
 * `crypto` so no external JWT dependency is needed.
 * @module
 */

import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { truncateForError } from './model.ts'

/** Default GitHub REST API base URL. */
export const DEFAULT_BASE_URL = 'https://api.github.com'
/** Default GitHub web URL. */
export const DEFAULT_WEB_URL = 'https://github.com'

/** App JWT lifetime. */
const APP_JWT_LIFETIME_SECONDS = 9 * 60
/** Backdate applied to the JWT `iat` claim. */
const APP_JWT_BACKDATE_SECONDS = 60
/** Refresh installation tokens this far before expiry. */
const TOKEN_REFRESH_BEFORE_MS = 5 * 60_000

/** A source of short-lived installation access tokens. */
export interface TokenSource {
  /**
   * Return a currently valid installation token, refreshing it when needed.
   * @param signal - optional cancellation for the refresh request.
   */
  token(signal?: AbortSignal): Promise<string>
}

/**
 * Build the base64url encoding used by JWTs.
 * @param value - raw bytes.
 * @returns unpadded base64url text.
 */
export function base64url(value: Buffer): string {
  return value.toString('base64url')
}

/**
 * Sign a GitHub App JWT with an RSA private key.
 * @param appId - GitHub App ID (`iss` claim).
 * @param keyPem - PEM-encoded RSA private key.
 * @param now - current instant.
 * @returns the signed compact JWT.
 */
export function makeAppJWT(appId: string, keyPem: string, now: Date): string {
  const appID = appId.trim()
  if (appID === '') throw new Error('github app_id is required')
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iat: Math.floor(now.getTime() / 1000) - APP_JWT_BACKDATE_SECONDS,
    exp: Math.floor(now.getTime() / 1000) + APP_JWT_LIFETIME_SECONDS,
    iss: appID,
  }
  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(keyPem))
  return `${unsigned}.${base64url(signature)}`
}

/**
 * Exchange an app JWT for an installation access token.
 * @param baseURL - GitHub API base URL.
 * @param installationId - installation to mint a token for.
 * @param jwt - signed app JWT.
 * @param signal - optional cancellation.
 * @returns the token and its expiry instant.
 */
export async function createInstallationToken(
  baseURL: string,
  installationId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt: Date }> {
  const url = `${baseURL}/app/installations/${encodeURIComponent(installationId)}/access_tokens`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: '{}',
    signal,
  })
  const body = await response.text()
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`create github installation token: status=${response.status} body=${truncateForError(body)}`)
  }
  const parsed = JSON.parse(body) as { token?: unknown; expires_at?: unknown }
  const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
  if (token === '') throw new Error('github installation token response missing token')
  const expiresAtRaw = typeof parsed.expires_at === 'string' ? parsed.expires_at : ''
  const expiresAt = new Date(expiresAtRaw)
  if (expiresAtRaw === '' || Number.isNaN(expiresAt.getTime())) {
    throw new Error('github installation token response missing expires_at')
  }
  return { token, expiresAt }
}

/** Cached installation token source for one GitHub App installation. */
export class AppTokenSource implements TokenSource {
  private keyPem: string
  private cachedToken = ''
  private cachedExpiresAt = new Date(0)

  /**
   * @param appId - GitHub App ID.
   * @param installationId - installation to mint tokens for.
   * @param keyPem - PEM-encoded RSA private key.
   * @param baseURL - GitHub API base URL.
   * @param now - clock override for tests.
   */
  constructor(
    readonly appId: string,
    readonly installationId: string,
    keyPem: string,
    readonly baseURL: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.keyPem = keyPem
  }

  /**
   * Read a PEM key file and build a token source.
   * @param appId - GitHub App ID.
   * @param installationId - installation to mint tokens for.
   * @param keyPath - path to the PEM private key.
   * @param baseURL - GitHub API base URL.
   * @param now - clock override for tests.
   */
  static async fromFile(
    appId: string,
    installationId: string,
    keyPath: string,
    baseURL: string,
    now: () => Date = () => new Date(),
  ): Promise<AppTokenSource> {
    let data: string
    try {
      data = await readFile(keyPath, 'utf8')
    } catch (error) {
      throw new Error(`read github app private key ${keyPath}: ${String(error)}`)
    }
    // Validate eagerly so a bad key fails at load, not on the first review.
    createPrivateKey(data)
    return new AppTokenSource(appId, installationId, data, baseURL, now)
  }

  /**
   * Return a currently valid installation token.
   * @param signal - optional cancellation for the refresh request.
   * @returns the bearer token.
   */
  async token(signal?: AbortSignal): Promise<string> {
    const now = this.now()
    if (this.cachedToken !== '' && now.getTime() + TOKEN_REFRESH_BEFORE_MS < this.cachedExpiresAt.getTime()) {
      return this.cachedToken
    }
    const jwt = makeAppJWT(this.appId, this.keyPem, now)
    const refreshed = await createInstallationToken(this.baseURL, this.installationId, jwt, signal)
    this.cachedToken = refreshed.token
    this.cachedExpiresAt = refreshed.expiresAt
    return refreshed.token
  }
}
