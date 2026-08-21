import { transform } from 'esbuild'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'github-reviewer-standard-decorators',
    enforce: 'pre',
    async transform(code, id) {
      if (!id.endsWith('/src/index.ts') || !code.includes('@Remote')) return
      const result = await transform(code, {
        loader: 'ts',
        target: 'es2022',
        sourcefile: id,
        sourcemap: 'external',
      })
      return { code: result.code, map: result.map }
    },
  }],
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
