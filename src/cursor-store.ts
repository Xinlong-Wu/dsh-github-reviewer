/**
 * Cursor state persistence through the harness storage domain: one record
 * per account in the `dsh_github_reviewer` domain, backed by whatever
 * storage backend the deployment routes to the domain (JSON files or a real
 * SQLite database). Replaces the earlier per-account JSON file.
 * @module
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { CursorState } from './github/cursor.ts'
import { CURSOR_STATUS_MISSING_INSTRUCTIONS, CURSOR_STATUS_REVIEWED, emptyCursorState } from './github/cursor.ts'

/** Runtime schema for one cursor entry, matching {@link CursorState}. */
const cursorEntrySchema = z.object({
  headSHA: z.string(),
  status: z.enum([CURSOR_STATUS_REVIEWED, CURSOR_STATUS_MISSING_INSTRUCTIONS]),
  updatedAt: z.string().optional(),
  lastCommentCheck: z.string().optional(),
})

/** Runtime schema for the whole per-account cursor row. */
const cursorRowSchema = z.object({
  prs: z.record(z.string(), cursorEntrySchema),
}) as unknown as z.ZodType<CursorState>

/** The storage-domain declaration: one row per account, keyed by account name. */
export const cursorDomainSpec = defineDomain({
  name: 'dsh_github_reviewer',
  version: 0,
  tables: {
    accounts: domainTable<string, CursorState>(cursorRowSchema),
  },
})

/** Cursor persistence seam used by the poller. */
export interface CursorStore {
  /** Load the current cursor for the account; absent records load as empty. */
  load(): Promise<CursorState>
  /** Persist the whole cursor for the account. */
  save(state: CursorState): Promise<void>
}

/** Storage-domain-backed cursor store for one account. */
export class StorageDomainCursorStore implements CursorStore {
  /**
   * @param table - the `accounts` table of the open cursor domain.
   * @param accountKey - the account name; the record key for this store.
   */
  constructor(
    private readonly table: KvTable<string, CursorState>,
    private readonly accountKey: string,
  ) {}

  /**
   * Load the account's cursor record, or an empty cursor when absent.
   * @returns the current cursor state.
   */
  async load(): Promise<CursorState> {
    return this.table.get(this.accountKey) ?? emptyCursorState()
  }

  /**
   * Persist the account's cursor record durably through the domain.
   * @param state - the full new cursor state.
   */
  async save(state: CursorState): Promise<void> {
    await this.table.put(this.accountKey, state)
  }
}
