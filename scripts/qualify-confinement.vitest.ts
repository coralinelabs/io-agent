/** The suite's own configuration, plus the real-backend specs (`*.e2e.ts`) the confinement qualification runs. */
import { fileURLToPath } from 'node:url'
import base from '../vitest.config.ts'

export default {
  ...base,
  test: { ...base.test, root: fileURLToPath(new URL('..', import.meta.url)),
    include: [...(base.test?.include ?? []), 'tests/**/*.e2e.ts'] },
}
