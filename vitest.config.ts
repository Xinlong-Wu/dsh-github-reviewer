import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
      reporter: ['text', 'json'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // High-risk modules keep their own floor so regressions in the guard,
        // poller, API client, or token source cannot hide behind aggregate coverage.
        'src/github/guard.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/poller.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/github/client.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/github/auth.ts': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
})
