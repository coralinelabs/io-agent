/** Test data only: mount imported plugins directly. No runtime profile loader. */
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import type { Context } from '../../src/library/runtime/vendor/cordis/index.ts'
export async function composeFixture(ctx: Context, path: string, resolve: (name: string) => unknown): Promise<void> {
  const rows: { name: string; config?: unknown; disabled?: boolean }[] = parse(await readFile(path, 'utf8'))
  const fibers = []
  for (const row of rows) {
    if (row.disabled) continue
    const plugin = await resolve(row.name) as Parameters<Context['plugin']>[0]
    fibers.push(ctx.plugin(plugin, row.config))
  }
  await Promise.all(fibers.map(fiber => fiber.await()))
}
