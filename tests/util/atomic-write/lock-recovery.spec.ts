/** DSH dead-holder takeover plus io acquisition cancellation; actual filesystem and child PID tests. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { withFileLock, writeFileAtomic } from '../../../src/library/util/atomic-write/index.ts'
const dirs:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})))})
async function file(){const dir=await mkdtemp(join(tmpdir(),'io-lock-recovery-'));dirs.push(dir);return join(dir,'state.json')}
async function orphan(path:string){
  const child=spawn(process.execPath,['-e',`require('node:fs').writeFileSync(process.argv[1]+'.lock',process.pid+'\\n',{flag:'wx',mode:0o600});process.stdout.write('ready\\n');setInterval(()=>{},10000)`,path],{stdio:['ignore','pipe','pipe']})
  let stderr='';child.stderr.on('data',b=>{stderr+=b})
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>reject(new Error('early exit '+code+stderr)))})
  const exited=new Promise<void>(r=>child.once('exit',()=>r()))
  child.kill('SIGKILL');await exited
  return child.pid!
}
describe('writer lock recovery',()=>{
  it('recovers a lock left by a killed process, retaining atomic fsync writes',async()=>{
    const path=await file();await orphan(path)
    await withFileLock(path,()=>writeFileAtomic(path,'recovered',{mode:0o600}))
    expect(await readFile(path,'utf8')).toBe('recovered')
    expect((await readdir(join(path,'..'))).filter(x=>x.includes('.lock'))).toEqual([])
  })
  it('serializes simultaneous contenders for the same exited holder',async()=>{
    const path=await file();await writeFile(path,'0');await orphan(path)
    let inFlight=0,max=0
    await Promise.all(Array.from({length:8},()=>withFileLock(path,async()=>{
      max=Math.max(max,++inFlight)
      const value=Number(await readFile(path,'utf8'));await new Promise(r=>setTimeout(r,5))
      await writeFileAtomic(path,String(value+1),{mode:0o600});inFlight--
    },{waitMs:5000})))
    expect(max).toBe(1);expect(await readFile(path,'utf8')).toBe('8')
  })
  it.each(['','123','0\n','2147483648\n','not-a-pid\n'])("does not steal incomplete or invalid records: %j",async record=>{
    const path=await file();await writeFile(path+'.lock',record)
    const operation=vi.fn(async()=>{})
    await expect(withFileLock(path,operation,{waitMs:5})).rejects.toThrow('timed out')
    expect(operation).not.toHaveBeenCalled();expect(await readFile(path+'.lock','utf8')).toBe(record)
  })
  it('does not steal its own lock even if a hostile probe reports ESRCH',async()=>{
    const path=await file();await writeFile(path+'.lock',`${process.pid}\n`)
    vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('missing'),{code:'ESRCH'})})
    await expect(withFileLock(path,async()=>{}, {waitMs:5})).rejects.toThrow('timed out')
  })
  it('does not treat EPERM as proof that an owner has exited',async()=>{
    const path=await file();await writeFile(path+'.lock','12345\n')
    vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('permission'),{code:'EPERM'})})
    await expect(withFileLock(path,async()=>{}, {waitMs:5})).rejects.toThrow('timed out')
    expect(await readFile(path+'.lock','utf8')).toBe('12345\n')
  })
  it('aborts waiting promptly without deleting a live holder or starting the operation',async()=>{
    const path=await file();const locked=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
    const held=withFileLock(path,async()=>{locked.resolve();await release.promise});await locked.promise
    const cancel=new AbortController(),operation=vi.fn(async()=>{})
    const waiting=withFileLock(path,operation,{waitMs:10000,signal:cancel.signal})
    cancel.abort(new Error('not needed'))
    await expect(waiting).rejects.toThrow('not needed')
    expect(operation).not.toHaveBeenCalled();expect(await readFile(path+'.lock','utf8')).toBe(`${process.pid}\n`)
    release.resolve();await held
  })
  it('validates waits before creating a lock and refuses pre-aborted acquisitions',async()=>{
    const path=await file()
    for(const waitMs of [-1,NaN,Infinity]) await expect(withFileLock(path,async()=>{}, {waitMs})).rejects.toThrow('waitMs')
    await expect(withFileLock(path,async()=>{}, {signal:AbortSignal.abort(new Error('stopped'))})).rejects.toThrow('stopped')
    expect(await readdir(join(path,'..'))).toEqual([])
  })
})
