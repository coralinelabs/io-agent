import { describe, expect, it } from 'vitest'
import { fixture, stream, tool } from './fixture.ts'
import { createExtensionManager, type ExtensionManager, type Context } from '../../../src/library/extensions/index.ts'
import { defineTool } from '../../../src/library/tools/index.ts'

function plugin(value: string, calls: string[]) {
  return { inject: ['tools'], apply(ctx: Context): void {
    ctx.tools.register(defineTool({ name: 'live_probe', description: `Live version ${value}`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: String(result) }] },
      async execute() { calls.push(value); return value },
    }))
  } }
}

describe('live extensions on the default agent path', () => {
  it('updates advertised schemas and real execution, then withdraws a removed tool', async () => {
    let manager!: ExtensionManager, revision = 0
    const calls: string[] = []
    const f = await fixture((_req, res, index) => {
      if (index < 4 && index % 2 === 0) tool(res, 'live_probe', {}, `probe-${index}`)
      else stream(res, [{ content: 'Finished.' }])
    }, { async configure(ctx) {
      manager = createExtensionManager(ctx)
      revision = (await manager.install({ id: 'probe', config: {}, load: () => plugin('one', calls) })).revision
    } })
    const session = await f.app.createSession()
    await session.run('Call the available probe.')
    revision = (await manager.replace({ id: 'probe', config: {}, load: () => plugin('two', calls) }, revision)).revision
    await session.run('Call the updated probe.')
    expect(calls).toEqual(['one', 'two'])
    expect(JSON.stringify(f.requests[0]?.tools)).toContain('Live version one')
    expect(JSON.stringify(f.requests[2]?.tools)).toContain('Live version two')
    await manager.remove('probe', revision)
    await session.run('Report which capabilities remain.')
    expect(f.requests.at(-1)?.tools?.some(t => t.function.name === 'live_probe')).toBe(false)
    expect(calls).toEqual(['one', 'two'])
  }, 30_000)

  it('replacement during policy admission cannot execute a successor under an older call', async () => {
    let manager!: ExtensionManager, revision = 0
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), calls: string[] = []
    const f = await fixture((_req, res, index) => index === 0 ? tool(res, 'live_probe', {}, 'old-call') : stream(res, [{content:'Observed the change.'}]), {
      async configure(ctx) {
        manager = createExtensionManager(ctx)
        revision = (await manager.install({ id: 'probe', config: {}, load: () => plugin('one', calls) })).revision
        ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'live_probe') { entered.resolve(); await release.promise }; return next() })
      },
    })
    const session = await f.app.createSession(), running = session.run('Use the probe.')
    try {
      await entered.promise
      await manager.replace({ id: 'probe', config: {}, load: () => plugin('two', calls) }, revision)
    } finally { release.resolve() }
    await running
    expect(calls).toEqual([])
    expect(f.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('changed or was withdrawn') })
    expect(String(f.requests.at(-1)?.messages.at(-1)?.content)).toContain('No tool body ran')
  }, 30_000)
})

it('live policy changes preserve an executing operation and apply at the next admission', async () => {
  const {z} = await import('zod')
  const {liveConfig} = await import('../../../src/library/extensions/index.ts')
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const calls:number[]=[];let mounts=0,manager!:ExtensionManager,revision=0
  const Config=z.object({limit:z.number().positive()}).transform(liveConfig)
  const f=await fixture((_req,res,index)=>{
    if(index%2===0) tool(res,'live_policy',{},`live-${index}`)
    else stream(res,[{content:'Finished.'}])
  },{async configure(ctx){
    manager=createExtensionManager(ctx)
    revision=(await manager.install({id:'policy',config:{limit:1},load:()=>({Config,inject:['tools'],apply(owner:Context,config:import('../../../src/library/extensions/index.ts').LiveConfig<{limit:number}>){
      mounts++
      owner.tools.register(defineTool({name:'live_policy',description:'Return the active policy.',parameters:{},
        output:{schema:{type:'number'},render:(_args,result)=>[{type:'text',text:String(result)}]},
        async execute(){const policy=config.get();if(calls.length===0){entered.resolve();await release.promise}calls.push(policy.limit);return policy.limit},
      }))
    }})})).revision
  }})
  const session=await f.app.createSession()
  const first=session.run('Read current policy.')
  await entered.promise
  await manager.configure('policy',{limit:2},revision)
  release.resolve();await first
  await session.run('Read the current policy again.')
  expect(calls).toEqual([1,2]);expect(mounts).toBe(1)
  expect(f.requests[0]!.tools).toEqual(f.requests[2]!.tools)
},30_000)
