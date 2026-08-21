/** Stable account-scoped identity helpers for persisted GitHub reviewer Sessions. */

/** Return the prefix shared by every persisted reviewer Session for one account. */
export function sessionKeyPrefix(accountName: string): string {
  const safeAccount = accountName.replace(/[^a-zA-Z0-9_.-]+/g, '_')
  return `github:${safeAccount}:`
}

/** Whether an id matches the complete generated PR Session grammar for one account. */
export function isReviewerSessionKey(accountName: string, sessionId: string): boolean {
  const prefix = sessionKeyPrefix(accountName)
  if (!sessionId.startsWith(prefix)) return false
  return /^[^:]+:[^:]+:pr:[1-9]\d*$/.test(sessionId.slice(prefix.length))
}
