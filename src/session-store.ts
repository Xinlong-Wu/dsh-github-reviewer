/**
 * Per-PR session history: one bounded conversation per PR, shared by
 * automated reviews and `/bot` chat, so later interactions on the same PR
 * replay what happened before. Keyed by `owner/repo#number` — the same key
 * as the review cursor, matching LingoBridge's per-PR session keying.
 *
 * Only model-visible text is kept: user prompts, human comments, and
 * assistant replies. Tool calls and tool results are transient scratch and
 * are never persisted or replayed.
 * @module
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One stored message: role plus plain text. */
export interface StoredMessage {
  role: 'user' | 'assistant'
  text: string
}

/** Whole session file: histories keyed by `owner/repo#number`. */
export interface SessionState {
  sessions: Record<string, StoredMessage[]>
}

/** An empty session state. */
export function emptySessionState(): SessionState {
  return { sessions: {} }
}

/**
 * Decode a raw session file body.
 * @param body - raw JSON file content.
 * @returns the decoded state; an empty body decodes to empty sessions.
 * @throws when the JSON is malformed.
 */
export function decodeSessions(body: string): SessionState {
  if (body.trim() === '') return emptySessionState()
  const parsed = JSON.parse(body) as Partial<SessionState>
  if (typeof parsed !== 'object' || parsed === null) throw new Error('github reviewer session file is not a JSON object')
  const sessions = parsed.sessions
  if (sessions === undefined) return emptySessionState()
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    throw new Error('github reviewer session file "sessions" is not a JSON object')
  }
  const out: SessionState = { sessions: {} }
  for (const [key, raw] of Object.entries(sessions)) {
    if (!Array.isArray(raw)) continue
    const messages: StoredMessage[] = []
    for (const message of raw) {
      if (
        typeof message === 'object' && message !== null
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.text === 'string'
        && message.text.trim() !== ''
      ) {
        messages.push({ role: message.role, text: message.text })
      }
    }
    if (messages.length > 0) out.sessions[key] = messages
  }
  return out
}

/**
 * Encode session state as the file body.
 * @param state - state to encode.
 * @returns stable JSON with sorted keys.
 */
export function encodeSessions(state: SessionState): string {
  const sessions: Record<string, StoredMessage[]> = {}
  for (const key of Object.keys(state.sessions).sort()) {
    sessions[key] = state.sessions[key]
  }
  return `${JSON.stringify({ sessions }, null, 2)}\n`
}

/**
 * Append one message to a PR's history, trimming the oldest messages beyond
 * `maxMessages`.
 * @param state - session state to update in place.
 * @param key - `owner/repo#number` session key.
 * @param message - message to append.
 * @param maxMessages - bound on the stored history length.
 */
export function appendSessionMessage(
  state: SessionState,
  key: string,
  message: StoredMessage,
  maxMessages: number,
): void {
  if (message.text.trim() === '') return
  let history = state.sessions[key]
  if (history === undefined) {
    history = []
    state.sessions[key] = history
  }
  history.push(message)
  if (history.length > maxMessages) {
    state.sessions[key] = history.slice(-maxMessages)
  }
}

/** File-backed session store for one account. */
export class JsonFileSessionStore {
  private state: SessionState | undefined

  /**
   * @param filePath - absolute or relative path of the session file.
   * @param maxMessages - bound on each PR's stored history length.
   */
  constructor(
    readonly filePath: string,
    readonly maxMessages: number,
  ) {}

  /**
   * Load the session file once, decoding an empty or missing file as empty.
   * @returns the loaded state.
   * @throws when the file exists but is malformed.
   */
  async load(): Promise<SessionState> {
    if (this.state !== undefined) return this.state
    let body: string
    try {
      body = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT') {
        this.state = emptySessionState()
        return this.state
      }
      throw error
    }
    this.state = decodeSessions(body)
    return this.state
  }

  /**
   * Persist the session state atomically.
   * @param state - state to persist.
   */
  async save(state: SessionState): Promise<void> {
    this.state = state
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body = encodeSessions(state)
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, body, 'utf8')
    try {
      await rename(tmpPath, this.filePath)
    } catch (error) {
      // Best-effort cleanup; the next save replaces the temp file anyway.
      try { await unlink(tmpPath) } catch { /* already gone */ }
      throw error
    }
  }

  /** Default session path for one account. */
  static defaultPath(accountName: string): string {
    return join('.dsh-github-reviewer', `${accountName}.sessions.json`)
  }
}
