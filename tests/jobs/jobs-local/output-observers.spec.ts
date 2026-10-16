import { describe, it, expect } from 'vitest'
import { Context } from '../../../src/library/runtime/vendor/cordis/index.ts'
import LocalJobRegistry from '../../../src/library/execution/jobs/jobs-local/index.ts'
import type { JobOutcome, JobOutputCursor } from '../../../src/library/execution/jobs/jobs/index.ts'

async function setup(capacity=1024) {
  const ctx=new Context(); const fiber=await ctx.plugin(LocalJobRegistry, {maxOutputBytes:capacity}); ctx.jobs.attachController('test')
  let buffer=''; let settle!:(result:JobOutcome)=>void; let broken=false; let cancelled=0
  const id=ctx.jobs.start({kind:'bash', label:'controlled producer',run:()=>({
    done:new Promise(r=>{settle=r}),cancel(){cancelled++; settle({status:'killed'})},
    readOutput(){if(broken) throw new Error('output store unavailable'); const text=buffer;buffer='';return text},
  })})
  return {ctx,id,close:()=>fiber.dispose(),write(t:string){buffer+=t},settle,breakOutput(v:boolean){broken=v},cancelled:()=>cancelled}
}
const tick=()=>new Promise(r=>setTimeout(r,0))

describe('independent job output cursors',()=>{
  it('host observation does not consume output owed to the model',async()=>{
    const h=await setup(); h.write('first\n')
    const a=h.ctx.jobs.readAt(h.id); expect(a.text).toBe('first\n')
    expect(h.ctx.jobs.read(h.id).text).toBe('first\n')
    expect(h.ctx.jobs.read(h.id).text).toBe('')
    h.write('second\n')
    expect(h.ctx.jobs.readAt(h.id,{cursor:a.cursor}).text).toBe('second\n')
    expect(h.ctx.jobs.read(h.id).text).toBe('second\n')
    h.settle({status:'completed'});await tick();await h.close()
  })
  it('terminal observation does not claim the agent completion notice',async()=>{
    const h=await setup();h.write('final');h.settle({status:'completed'});await tick()
    expect(h.ctx.jobs.readAt(h.id).snapshot.reported).toBe(false)
    expect(h.ctx.jobs.read(h.id)).toMatchObject({text:'final',snapshot:{reported:true}})
    await h.close()
  })
  it('stalled observers see explicit gaps without unbounded event queues',async()=>{
    const h=await setup(12);h.write('start');const a=h.ctx.jobs.readAt(h.id)
    h.write('12345678901234567890');const b=h.ctx.jobs.readAt(h.id,{cursor:a.cursor})
    expect(b).toMatchObject({text:'901234567890',lossy:true,total:25})
    expect(h.ctx.jobs.read(h.id).lossy).toBe(true)
    h.settle({status:'completed'});await tick();await h.close()
  })
  it('does not accept a cursor for a different job stream',async()=>{
    const h=await setup();const cursor:JobOutputCursor={streamId:'previous-process',offset:0}
    expect(()=>h.ctx.jobs.readAt(h.id,{cursor})).toThrow('different stream generation')
    h.settle({status:'completed'});await tick();await h.close()
  })
  it('does not turn output collection failure into failed execution',async()=>{
    const h=await setup();h.write('result');h.breakOutput(true);h.settle({status:'completed'});await tick()
    expect(h.ctx.jobs.readAt(h.id)).toMatchObject({snapshot:{status:'completed'},outputError:'Error: output store unavailable'})
    h.breakOutput(false);expect(h.ctx.jobs.read(h.id).text).toBe('result');await h.close()
  })
  it('releases pending observer pulls on abort without cancelling the job',async()=>{
    const h=await setup();const cancel=new AbortController();const it=h.ctx.jobs.follow(h.id,{},undefined,cancel.signal)[Symbol.asyncIterator]()
    await it.next();const pending=it.next();cancel.abort(new Error('detached'))
    await expect(pending).rejects.toThrow('detached');expect(h.cancelled()).toBe(0)
    expect(h.ctx.jobs.get(h.id).status).toBe('running')
    h.settle({status:'completed'});await tick();await h.close()
  })
  it('drains final output before publishing terminal status to every observer',async()=>{
    const h=await setup();const it=h.ctx.jobs.follow(h.id)[Symbol.asyncIterator]();const first=await it.next()
    expect(first.value.snapshot.status).toBe('running')
    const pending=it.next();h.write('done');h.settle({status:'completed'})
    expect((await pending).value).toMatchObject({text:'done',snapshot:{status:'completed',reported:false}})
    expect((await it.next()).done).toBe(true)
    expect(h.ctx.jobs.read(h.id).text).toBe('done');await h.close()
  })
  it('keeps final-output-only reads idempotent while live observation is bounded',async()=>{
    const ctx=new Context();const fiber=await ctx.plugin(LocalJobRegistry,{maxOutputBytes:8});ctx.jobs.attachController('test')
    const id=ctx.jobs.start({kind:'bash',label:'final',run:()=>({done:Promise.resolve({status:'completed',output:'abcdefghijkl'}),cancel(){}})})
    await tick();expect(ctx.jobs.readAt(id)).toMatchObject({text:'efghijkl',lossy:true})
    expect(ctx.jobs.read(id).text).toBe('abcdefghijkl');expect(ctx.jobs.read(id).text).toBe('abcdefghijkl');expect(ctx.jobs.read(id).lossy).toBeUndefined();await fiber.dispose()
  })
})

 it('seals successfully drained terminal output before the producer resources disappear',async()=>{
    const ctx=new Context();const fiber=await ctx.plugin(LocalJobRegistry);ctx.jobs.attachController('test')
    const end=Promise.withResolvers<JobOutcome>();let closed=false,reads=0
    const id=ctx.jobs.start({kind:'bash',label:'sealed',run:()=>({done:end.promise,cancel(){},readOutput(){
      reads++;if(closed)throw new Error('producer disposed');return 'last evidence'
    }})})
    end.resolve({status:'completed'});await tick();closed=true
    expect(ctx.jobs.readAt(id).text).toBe('last evidence');expect(ctx.jobs.readAt(id).outputError).toBeUndefined()
    expect(ctx.jobs.read(id).text).toBe('last evidence');expect(ctx.jobs.read(id).text).toBe('');expect(reads).toBe(1)
    await fiber.dispose()
  })

  it('keeps a canonical final report idempotent independently of streamed progress and preview eviction',async()=>{
    const ctx=new Context();const fiber=await ctx.plugin(LocalJobRegistry,{maxOutputBytes:8});ctx.jobs.attachController('test')
    const end=Promise.withResolvers<JobOutcome>();let progress='progress'
    const id=ctx.jobs.start({kind:'bash',label:'report',run:()=>({done:end.promise,cancel(){},readOutput(){const p=progress;progress='';return p}})})
    expect(ctx.jobs.readAt(id).text).toBe('progress')
    end.resolve({status:'completed',output:'complete report'});await tick()
    expect(ctx.jobs.readAt(id)).toMatchObject({text:'e report',lossy:true,total:23})
    expect(ctx.jobs.read(id).text).toBe('complete report');expect(ctx.jobs.read(id).text).toBe('complete report')
    expect(ctx.jobs.read(id).lossy).toBeUndefined();await fiber.dispose()
  })
