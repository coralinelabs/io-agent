import { describe, it, expect, vi } from 'vitest'
import { hostFixture, turn, run } from './host-fixture.ts'
import { stream, tool } from './fixture.ts'
import { SessionId } from '../../../src/library/session/journal/index.ts'
import type { JobOutcome } from '../../../src/library/execution/jobs/jobs/index.ts'

describe('live output through the real host/agent path',()=>{
  it('two host readers do not consume the model job_output result or trigger inference',async()=>{
    const f=await hostFixture((request,res)=>{
      if(!request.messages.some(m=>m.role==='tool'))tool(res,'job_output',{job_id:'bash-1'})
      else {expect(JSON.stringify(request.messages)).toContain('EVIDENCE_FOR_THE_MODEL');stream(res,[{content:'Read the evidence.'}])}
    })
    const id=await f.host.createSession();const owner=f.context().agents.get(SessionId(id))!
    let data='EVIDENCE_FOR_THE_MODEL';const end=Promise.withResolvers<JobOutcome>()
    const jobId=f.context().jobs.start({kind:'bash',label:'test',owner,run:()=>({done:end.promise,cancel(){end.resolve({status:'killed'})},readOutput(){const out=data;data='';return out}})})
    const a=f.host.readLiveJobOutput(id,jobId),b=f.host.readLiveJobOutput(id,jobId)
    expect(a.text).toBe('EVIDENCE_FOR_THE_MODEL');expect(b.text).toBe(a.text);expect(f.requests).toHaveLength(0)
    await run(f.host,turn(id,'Read the background evidence.'))
    expect(f.requests).toHaveLength(2)
    end.resolve({status:'completed',reported:true})
    await vi.waitFor(()=>expect(f.context().jobs.get(jobId,owner).status).toBe('completed'))
  })
  it('observers can reconnect and disconnect without claiming completion or killing work',async()=>{
    const f=await hostFixture((_r,res)=>stream(res,[{content:'unused'}]))
    const id=await f.host.createSession(),owner=f.context().agents.get(SessionId(id))!
    const end=Promise.withResolvers<JobOutcome>();let data='A';let cancelled=0
    const jobId=f.context().jobs.start({kind:'bash',label:'test',owner,run:()=>({done:end.promise,cancel(){cancelled++;end.resolve({status:'killed'})},readOutput(){const out=data;data='';return out}})})
    const stop=new AbortController();const reader=f.host.followJobOutput(id,jobId,{},stop.signal)
    const first=await reader.next();expect(first.value.text).toBe('A')
    const blocked=reader.next();stop.abort(new Error('browser disconnect'));await expect(blocked).rejects.toThrow('browser disconnect')
    expect(cancelled).toBe(0);data='B'
    expect(f.host.readLiveJobOutput(id,jobId,{cursor:first.value.cursor}).text).toBe('B')
    expect(f.context().jobs.read(jobId,owner).text).toBe('AB')
    end.resolve({status:'completed',reported:true});await vi.waitFor(()=>expect(f.context().jobs.get(jobId,owner).status).toBe('completed'))
  })
  it('enforces exact session ownership before exposing any output',async()=>{
    const f=await hostFixture((_r,res)=>stream(res,[{content:'unused'}]))
    const a=await f.host.createSession(),b=await f.host.createSession(),owner=f.context().agents.get(SessionId(a))!
    const end=Promise.withResolvers<JobOutcome>()
    const job=f.context().jobs.start({kind:'bash',label:'private',owner,run:()=>({done:end.promise,cancel(){end.resolve({status:'killed'})},readOutput(){return 'SECRET'}})})
    expect(()=>f.host.readLiveJobOutput(b,job)).toThrow('another session')
    await expect(f.host.followJobOutput(b,job).next()).rejects.toThrow('another session')
    end.resolve({status:'completed',reported:true});await vi.waitFor(()=>expect(f.context().jobs.get(job,owner).status).toBe('completed'))
  })
})
