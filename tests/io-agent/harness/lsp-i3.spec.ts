import { describe, expect, it } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, stream, tool } from './fixture.ts'
import { mountLanguageServers, type LanguageServerMount } from '../../../src/library/integrations/code-intelligence.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { formatHover } from '../../../src/library/lsp/tool-lsp/render.ts'

const server = fileURLToPath(new URL('../../lsp/lsp-stdio/fixture-server.ts', import.meta.url))
const location = { uri: 'file:///workspace/definition.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } } }
function settings(extra: Record<string, string> = {}) {
  return { executionPolicy: 'native' as const, servers: { test: { command: process.execPath, args: [server],
    extensionToLanguage: { '.ts': 'typescript' }, env: { LSP_FAKE_HOVER: JSON.stringify({ contents: 'Documented meaning' }), ...extra },
    killGraceMs: 40, shutdownTimeoutMs: 200 } } }
}

describe('configured language servers on the default agent path', () => {
  it('advertises and executes all navigation operations, and reopens fresh content', async () => {
    let mount!: LanguageServerMount
    const operations = ['hover', 'goToDefinition', 'findReferences', 'goToImplementation']
    const f = await fixture((_req, res, index) => index % 2 === 0
      ? tool(res, 'lsp', { operation: operations[index / 2], file_path: 'source.ts', line: 1, character: 1 }, `nav-${index}`)
      : stream(res, [{ content: 'Used the evidence.' }]), { async configure(ctx) {
        mount = await mountLanguageServers(ctx, settings({ LSP_FAKE_DEF: JSON.stringify(location), LSP_FAKE_REFS: JSON.stringify([location]), LSP_FAKE_IMPL: JSON.stringify([location]) }))
      } })
    const session = await f.app.createSession()
    await writeFile(join(f.workspace, 'source.ts'), 'const value = 1\n')
    for (const operation of operations) await session.run(`Use ${operation}.`)
    expect(f.requests[0]?.tools?.some(t => t.function.name === 'lsp')).toBe(true)
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('Documented meaning')
    expect(JSON.stringify(f.requests[3]?.messages)).toContain('definition.ts:2:3')
    await mount.dispose()
    await session.run('Report remaining capabilities.')
    expect(f.requests.at(-1)?.tools?.some(t => t.function.name === 'lsp')).toBe(false)
  }, 30000)

  it('refuses a source outside the workspace and never changes source bytes', async () => {
    const f = await fixture((_req, res, index) => index === 0
      ? tool(res, 'lsp', { operation: 'hover', file_path: '../outside.ts', line: 1, character: 1 })
      : stream(res, [{content: 'Observed rejection.'}]), { async configure(ctx) { await mountLanguageServers(ctx, settings()) } })
    const outside = join(f.workspace, '../outside.ts')
    await writeFile(outside, 'private outside evidence')
    await (await f.app.createSession()).run('Inspect the source.')
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('outside the workspace')
    expect(JSON.stringify(f.requests[1]?.messages)).not.toContain('private outside evidence')
    expect(await readFile(outside, 'utf8')).toBe('private outside evidence')
  })

  it('does not turn a language-server navigation into mutation permission', async () => {
    const f = await fixture((_req, res, index) => index === 0
      ? tool(res, 'lsp', { operation:'hover', file_path:'source.ts', line:1, character:1 })
      : stream(res, [{content:'Finished.'}]), { async configure(ctx) { await mountLanguageServers(ctx, settings({LSP_FAKE_ON_OPEN:'applyEdit'})) } })
    await writeFile(join(f.workspace,'source.ts'),'original')
    await (await f.app.createSession()).run('Read documentation.')
    expect(await readFile(join(f.workspace,'source.ts'),'utf8')).toBe('original')
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('Documented meaning')
  })

  it('denied ordinary invocation cannot reach a native server', async () => {
    let calls = 0
    const f = await fixture((_req, res, index) => index === 0
      ? tool(res,'lsp',{operation:'hover',file_path:'source.ts',line:1,character:1}) : stream(res,[{content:'Denied.'}]), {
      async configure(ctx) {
        await mountLanguageServers(ctx, settings())
        ctx.tools.guard(exec => exec.name === 'lsp' ? 'No navigation allowed.' : undefined)
        ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'lsp') calls++; return next() })
      }
    })
    await writeFile(join(f.workspace,'source.ts'),'const x = 1')
    await (await f.app.createSession()).run('Navigate.')
    expect(calls).toBe(0)
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('No navigation allowed.')
  })

  it('rolls back failed provider setup and permits a clean subsequent mount', async () => {
    let ctx!: Context
    const f = await fixture((_req,res)=>stream(res,[{content:'Okay.'}]), { configure(c) { ctx=c } })
    await expect(mountLanguageServers(ctx, {...settings(), servers:{ bad:{command:'/missing/io-test-command',extensionToLanguage:{'.ts':'typescript'}}}})).rejects.toThrow()
    expect(ctx.tools.get('lsp')).toBeUndefined()
    const mounted = await mountLanguageServers(ctx, settings())
    await expect(mountLanguageServers(ctx, settings())).rejects.toThrow('already mounted')
    await mounted.dispose()
    await mounted.dispose()
    const next = await mountLanguageServers(ctx, settings())
    expect(ctx.tools.get('lsp')).toBeDefined()
    await next.dispose()
    await (await f.app.createSession()).run('Still functional.')
  })

  it('requires an explicit native-server execution policy', async () => {
    let ctx!: Context
    await fixture((_req,res)=>stream(res,[{content:'Okay.'}]), { configure(c) {ctx=c} })
    // @ts-expect-error native process authority must be explicitly acknowledged
    await expect(mountLanguageServers(ctx, {servers:settings().servers})).rejects.toThrow('executionPolicy')
    expect(ctx.tools.get('lsp')).toBeUndefined()
  })

  it('rejects an unrepresentable frame bound before publishing a capability', async () => {
    let ctx!: Context
    await fixture((_req,res)=>stream(res,[{content:'Okay.'}]), { configure(c) {ctx=c} })
    const options = settings()
    const key = Object.keys(options.servers)[0]!
    const tooLarge = { ...options, servers: { [key]: { ...options.servers[key]!, maxMessageBytes: Number.MAX_SAFE_INTEGER } } }
    await expect(mountLanguageServers(ctx, tooLarge)).rejects.toThrow('maximum message size')
    expect(ctx.tools.get('lsp')).toBeUndefined()
    const next = await mountLanguageServers(ctx, settings())
    await next.dispose()
  })

  it('bounds hover output without splitting a UTF-16 pair', () => {
    for (let limit=1; limit<160; limit++) {
      const rendered=formatHover({contents:'😀'.repeat(200)},limit)
      expect(rendered.length).toBeLessThanOrEqual(limit)
      expect(rendered.isWellFormed()).toBe(true)
    }
  })
})
