/** Full registry/loop integration; product I/O is covered separately by the ported protocol/lifecycle tests. */
import { describe, it, expect, vi } from 'vitest'
import { fixture, stream, tool } from './fixture.ts'
import { mountExternalAgent, type ExternalAgentMount } from '../../../src/library/integrations/external-agents.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import type { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import type { CodexRunSpec } from '../../../src/library/agents/subagent-codex/run.ts'
const native = vi.hoisted(() => ({ starts: [] as unknown[], disposals: 0, count: 0 }))
vi.mock('../../../src/library/agents/subagent-codex/run.ts', async original => ({
  ...await original<typeof import('../../../src/library/agents/subagent-codex/run.ts')>(),
  async startCodexRun(request: unknown, spec: unknown) {
    native.starts.push({ request, spec })
    return { id: `external-${++native.count}`, localAgent: undefined,
      result: Promise.resolve({ stopReason: 'end-turn', output: [{ type: 'text', text: 'NATIVE_AGENT_EVIDENCE' }] }),
      async dispose() { native.disposals++ },
    }
  },
}))

describe('optional native product integrations', () => {
  it('exposes both configured native tools without changing the main model route', async () => {
    const before = native.starts.length, disposed = native.disposals
    const f = await fixture((_req, res, index) => index === 0
      ? tool(res, 'subagent_codex', { description: 'Native independent review', prompt: 'Review the local workspace.' }, 'native-review')
      : stream(res, [{ content: 'Review received.' }]), {
      externalAgents: [{ kind:'codex', executionPolicy:'native', model:'native-model' }, { kind:'claude-code', executionPolicy:'native' }],
    })
    await (await f.app.createSession()).run('Request a native review.')
    expect(f.requests[0]?.tools?.map(t=>t.function.name)).toEqual(expect.arrayContaining(['subagent_codex','subagent_claude_code']))
    expect(native.starts).toHaveLength(before+1)
    const last = native.starts.at(-1) as {spec: CodexRunSpec}
    expect(last.spec.model).toBe('native-model'); expect(last.spec.cwd).toBe(f.workspace)
    expect(last.spec.permissionMode).toBe('never')
    expect(f.requests.every(r=>r.model==='fixture-model')).toBe(true)
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('NATIVE_AGENT_EVIDENCE')
    expect(native.disposals).toBe(disposed+1)
  }, 30_000)

  it('withdraws external tools from in-process children and releases mount identities on disposal', async () => {
    let ctx!: Context, mounted!: ExternalAgentMount
    const f = await fixture((_req, res) => stream(res,[{content:'Inspected the available capabilities.'}]), { configure(context) { ctx=context } })
    mounted = await mountExternalAgent(ctx,{kind:'codex',executionPolicy:'native'})
    const session = await f.app.createSession(); await session.run('Root work.')
    expect(f.requests[0]?.tools?.some(t=>t.function.name==='subagent_codex')).toBe(true)
    const parent = ctx.agents.get(SessionId(session.id))!
    const child = await ctx.subagents.start('spawn', {parent, prompt:[{type:'text',text:'CHILD_INSPECT'}], signal:new AbortController().signal})
    await child.result; await child.dispose()
    expect(f.requests.at(-1)?.tools?.some(t=>t.function.name==='subagent_codex')).toBe(false)
    await mounted.dispose()
    expect(ctx.subagents.getProvider('codex')).toBeUndefined()
    expect(ctx.tools.get('subagent_codex')).toBeUndefined()
    const again = await mountExternalAgent(ctx,{kind:'codex',executionPolicy:'native'})
    await again.dispose()
  }, 30_000)

  it('rolls partial startup back and snapshots configuration before asynchronous imports', async () => {
    let ctx!: Context
    await fixture((_req,res)=>stream(res,[{content:'Done.'}]),{configure(context){ctx=context}})
    await expect(mountExternalAgent(ctx,{kind:'codex',executionPolicy:'native',disposeGraceMs:0})).rejects.toThrow()
    expect(ctx.subagents.getProvider('codex')).toBeUndefined()
    const config = {kind:'codex' as const,executionPolicy:'native' as const,env:{CUSTOM_SETTING:'original'}}
    const pending=mountExternalAgent(ctx,config);config.env.CUSTOM_SETTING='changed'
    const mount=await pending
    await expect(mountExternalAgent(ctx,{kind:'codex',executionPolicy:'native'})).rejects.toThrow('already owned')
    // Provider configuration is captured before the first await, not borrowed from the caller.
    const provider=ctx.subagents.getProvider('codex') as unknown as {config:{env:Record<string,string>}}
    expect(provider.config.env.CUSTOM_SETTING).toBe('original')
    await mount.dispose()
  },30_000)
})
