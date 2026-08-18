/**
 * Cursor state persistence: one JSON file per account, written atomically
 * (temp file + rename) so a crash cannot leave a truncated cursor.
 * @module
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CursorState } from './github/cursor.ts'
import { decodeCursor, encodeCursor } from './github/cursor.ts'

/** File-backed cursor store for one account. */
export class JsonFileCursorStore {
  private state: CursorState | undefined

  /**
   * @param filePath - absolute or relative path of the cursor file.
   */
  constructor(readonly filePath: string) {}

  /**
   * Load the cursor file once, decoding an empty or missing file as empty.
   * @returns the loaded state.
   * @throws when the file exists but is malformed.
   */
  async load(): Promise<CursorState> {
    if (this.state !== undefined) return this.state
    let body: string
    try {
      body = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT') {
        this.state = decodeCursor('')
        return this.state
      }
      throw error
    }
    this.state = decodeCursor(body)
    return this.state
  }

  /**
   * Persist the cursor state atomically.
   * @param state - state to persist.
   */
  async save(state: CursorState): Promise<void> {
    this.state = state
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body = encodeCursor(state)
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

  /** Default cursor path for one account. */
  static defaultPath(accountName: string): string {
    return join('.dsh-github-reviewer', `${accountName}.json`)
  }
}
