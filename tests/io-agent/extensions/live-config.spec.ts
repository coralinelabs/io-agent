import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context, type Fiber } from '../../../src/library/runtime/vendor/cordis/index.ts'
import { createExtensionManager, liveConfig, type LiveConfig } from '../../../src/library/extensions/index.ts'
import { planLiveChanges } from '../../../src/library/extensions/live.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
function setup() { const ctx = new Context(); contexts.push(ctx); return { ctx, manager: createExtensionManager(ctx) } }
const Config = z.object({ fixed: z.string().default('same'), tuning: z.object({ size: z.number().int().positive(), labels: z.array(z.string()).default([]) }).transform(liveConfig) })
type Config = z.output<typeof Config>

describe('live configuration transactions', () => {
  it('updates stable references but leaves captured operation snapshots and resources unchanged', async () => {
    const {manager} = setup(); let config!: Config, active = 0, releases = 0
    const plugin = {Config, apply(ctx: Context, c: Config) { config = c; active++; ctx.effect(() => () => { releases++ }) }}
    const first = await manager.install({id:'probe', config:{tuning:{size:1}}, load:() => plugin})
    const ref = config.tuning, before = ref.get()
    const second = await manager.configure('probe',{tuning:{size:2, labels:['current']}},first.revision)
    expect(config.tuning).toBe(ref); expect(ref.get()).toEqual({size:2,labels:['current']}); expect(before).toEqual({size:1,labels:[]})
    expect(Object.isFrozen(ref.get().labels)).toBe(true); expect(active).toBe(1); expect(releases).toBe(0)
    expect(second.revision).toBeGreaterThan(first.revision)
  })

  it('validates every field before publishing any live values', async () => {
    const {manager} = setup(); let config!: Config
    const first = await manager.install({id:'probe', config:{tuning:{size:1}},load:() => ({Config,apply(_c:Context,c:Config){config=c}})})
    await expect(manager.configure('probe',{tuning:{size:2, labels:[42]}},first.revision)).rejects.toThrow('invalid config')
    expect(config.tuning.get()).toEqual({size:1,labels:[]}); expect(manager.list()[0]?.revision).toBe(first.revision)
  })

  it('remounts on an ordinary field change, retaining the old snapshot for old owners', async () => {
    const {manager} = setup(); const seen:Config[]=[]; let releases=0
    const first = await manager.install({id:'probe',config:{tuning:{size:1}},load:() => ({Config,apply(ctx:Context,c:Config){seen.push(c);ctx.effect(()=>()=>{releases++})}})})
    await manager.configure('probe',{fixed:'changed',tuning:{size:3}},first.revision)
    expect(seen).toHaveLength(2); expect(releases).toBe(1)
    expect(seen[0]!.tuning.get().size).toBe(1); expect(seen[1]!.tuning.get().size).toBe(3)
  })

  it('rollback after a later failed remount uses the last committed live configuration', async () => {
    const {manager} = setup(); const seen:number[]=[]
    const first = await manager.install({id:'probe',config:{tuning:{size:1}},load:() => ({Config,apply(_ctx:Context,c:Config){
      if(c.fixed==='fail') throw new Error('activation'); seen.push(c.tuning.get().size)
    }})})
    const second=await manager.configure('probe',{tuning:{size:2}},first.revision)
    await expect(manager.configure('probe',{fixed:'fail',tuning:{size:3}},second.revision)).rejects.toMatchObject({code:'ACTIVATION'})
    expect(seen).toEqual([1,2]); expect(manager.list()[0]).toEqual(second)
  })

  it('dependency reactivation receives the latest raw configuration as fresh references', async () => {
    const {ctx,manager}=setup(); const seen:Config[]=[]
    const provider=await ctx.plugin((owner:Context)=>{owner.provide('live-probe-dependency',{})})
    const first=await manager.install({id:'probe',config:{tuning:{size:1}},load:()=>({Config,inject:['live-probe-dependency'],apply(_c:Context,c:Config){seen.push(c)}})})
    await manager.configure('probe',{tuning:{size:2}},first.revision)
    const old=seen[0]!.tuning
    await provider.dispose()
    await ctx.plugin((owner:Context)=>{owner.provide('live-probe-dependency',{})})
    await vi.waitFor(()=>expect(seen).toHaveLength(2))
    expect(seen[1]!.tuning).not.toBe(old); expect(seen[1]!.tuning.get().size).toBe(2)
  })

  it('uses scoped internal/config hooks on update as well as activation', async () => {
    const {ctx,manager}=setup();let seen!:Config
    ctx.on('internal/config',(config:{tuning:{size:number}},next:()=>unknown)=>{
      config.tuning.size=Math.min(config.tuning.size,2);return next()
    },{global:true})
    const first=await manager.install({id:'probe',config:{tuning:{size:1}},load:()=>({Config,apply(_ctx:Context,c:Config){seen=c}})})
    await manager.configure('probe',{tuning:{size:90}},first.revision)
    expect(seen.tuning.get().size).toBe(2)
  })

  it('rejects stale updates without changing current config and snapshots input before queueing', async () => {
    const {manager}=setup();let seen!:Config
    const first=await manager.install({id:'probe',config:{tuning:{size:1}},load:()=>({Config,apply(_ctx:Context,c:Config){seen=c}})})
    const candidate={tuning:{size:2}}
    const pending=manager.configure('probe',candidate,first.revision); candidate.tuning.size=100
    await pending; expect(seen.tuning.get().size).toBe(2)
    await expect(manager.configure('probe',{tuning:{size:3}},first.revision)).rejects.toMatchObject({code:'STALE'})
    expect(seen.tuning.get().size).toBe(2)
  })

  it('commits multiple references and rejects non-JSON live values', async () => {
    const {manager}=setup();let seen!:{a:LiveConfig<number>,b:LiveConfig<string|undefined>}
    const schema=z.object({a:z.number().transform(liveConfig),b:z.string().optional().transform(liveConfig)})
    const first=await manager.install({id:'probe',config:{a:1,b:'first'},load:()=>({Config:schema,apply(_ctx:Context,c:typeof seen){seen=c}})})
    await manager.configure('probe',{a:2},first.revision)
    expect(seen.a.get()).toBe(2);expect(seen.b.get()).toBeUndefined()
    const cycle:{self?:unknown}={};cycle.self=cycle
    for(const invalid of [()=>{},new Date(),cycle,{nested:undefined},NaN]) expect(()=>liveConfig(invalid)).toThrow()
  })

  it('does not pretend opaque/cyclic ordinary state supports in-place mutation', () => {
    expect(planLiveChanges({a:liveConfig(1),b:new Date(0)},{a:liveConfig(2),b:new Date(0)})).toBeUndefined()
    const a:{self?:unknown}={},b:{self?:unknown}={};a.self=a;b.self=b
    expect(planLiveChanges(a,b)).toBeUndefined()
    const same=liveConfig(1)
    expect(planLiveChanges({a:same,b:same},{a:liveConfig(2),b:liveConfig(3)})).toBeUndefined()
  })

  it('invalid direct fiber updates do not poison raw config used by a later restart', async () => {
    const {ctx}=setup();const values:number[]=[]
    const fiber: Fiber=ctx.plugin({Config:z.object({value:z.number().positive()}),apply(_c:Context,c:{value:number}){values.push(c.value)}},{value:1})
    await fiber.await()
    expect(()=>fiber.update({value:-1})).toThrow('invalid config')
    await fiber.restart();await fiber.await()
    expect(values).toEqual([1,1])
  })
})
