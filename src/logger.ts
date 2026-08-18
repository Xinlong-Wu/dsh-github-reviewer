/**
 * Shared poll diagnostics observer.
 * @module
 */

/** Log observer used by the poller, runner, and guard. */
export interface PollLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Logger adapter binding the plugin to a Cordis logger. */
export function cordisLogger(logger: {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}): PollLogger {
  return {
    debug: message => logger.debug(message),
    info: message => logger.info(message),
    warn: message => logger.warn(message),
    error: message => logger.error(message),
  }
}

/** A logger that discards everything, for tests. */
export function silentLogger(): PollLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

/** A logger that records lines, for tests. */
export function recordingLogger(lines: string[]): PollLogger {
  return {
    debug: message => lines.push(`debug: ${message}`),
    info: message => lines.push(`info: ${message}`),
    warn: message => lines.push(`warn: ${message}`),
    error: message => lines.push(`error: ${message}`),
  }
}
