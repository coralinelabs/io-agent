import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './scripts/test-transform.ts'
export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'], exclude: ['tests/support/**'],
    execArgv: vitestExecArgv, maxWorkers: 2, testTimeout: 15000, hookTimeout: 30000 },
})
