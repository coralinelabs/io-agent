/** Real default composition + local HTTP/SSE; no live inference or mock child engine. */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, stream, tool } from './fixture.ts'
import type { SessionEvent } from '../../../src/library/session/journal/index.ts'
const outputs = (events: readonly SessionEvent[]) => events.filter(e => e.type === 'tool/result').map(e => e.data.message)
async function skill(workspace: string, frontmatter = '', body = 'ISOLATED_INSTRUCTION: read $FILE and report its content.') {
  const root = join(workspace, '.agents/skills/audit'); await mkdir(root, { recursive: true })
  const file = join(root, 'SKILL.md')
  await writeFile(file, `---\nname: audit\ndescription: A scoped audit.\n${frontmatter}---\n${body}\n`)
  return root
}

describe('iteration 6 real runtime', () => {
  it('runs a fork skill in fresh restricted child context through the configured router', async () => {
    const {app, workspace, requests} = await fixture((q,res,i) => {
      if (i === 0) tool(res,'skill',{name:'audit',arguments:'"input file.txt"'},'activate')
      else if (i === 1) {
        expect(JSON.stringify(q.messages)).toContain('ISOLATED_INSTRUCTION: read input file.txt')
        expect(JSON.stringify(q.messages)).not.toContain('PARENT_PRIVATE_MARKER')
        const names = q.tools?.map(t => t.function.name) ?? []
        expect(names).toContain('read'); expect(names).not.toContain('write'); expect(names).not.toContain('bash')
        tool(res,'read',{file_path:'input file.txt'},'child-read')
      } else if (i === 2) stream(res,[{content:'Child checked INPUT_DATA.'}])
      else stream(res,[{content:'Parent received the report.'}])
    }, {skills:{watch:false}})
    await skill(workspace,'context: fork\nallowed-tools: [read]\narguments: [file]\n')
    await writeFile(join(workspace,'input file.txt'),'INPUT_DATA')
    const result = await (await app.createSession()).run('PARENT_PRIVATE_MARKER: use the audit skill for the file.')
    expect(requests).toHaveLength(4); expect(requests.every(r => r.model === 'fixture-model')).toBe(true)
    expect(result.stopReason?.kind).toBe('completed'); expect(outputs(result.events).some(v => v.isError)).toBe(false)
    expect(JSON.stringify(requests[3]!.messages)).toContain('Child checked INPUT_DATA')
    expect(JSON.stringify(requests[3]!.messages)).not.toContain('ISOLATED_INSTRUCTION')
  },30000)
  it('uses ordinary subagent policy, rather than bypassing it to execute a skill', async () => {
    let denied = 0
    const {app,workspace,requests} = await fixture((_q,res,i) => i === 0
      ? tool(res,'skill',{name:'audit'},'activate') : stream(res,[{content:'Child was denied.'}]), {
      skills:{watch:false}, configure: ctx => { ctx.on('tools/pre-execute', async (exec,next) => {
        if (exec.name === 'subagent') { denied++; return {kind:'deny',reason:'DENIED_CHILD_FIXTURE'} }
        return next()
      }, {prepend:true}) },
    })
    await skill(workspace,'context: fork\nallowed-tools: [read]\n')
    const result = await (await app.createSession()).run('Use audit.')
    expect(denied).toBe(1); expect(requests).toHaveLength(2)
    expect(outputs(result.events).some(v => v.isError)).toBe(true)
    expect(JSON.stringify(requests[1]!.messages)).toContain('DENIED_CHILD_FIXTURE')
  },30000)
  it('enforces the child restriction even when the model requests an unadvertised write', async () => {
    const {app,workspace,requests} = await fixture((_q,res,i) => {
      if (i === 0) tool(res,'skill',{name:'audit'},'activate')
      else if (i === 1) tool(res,'write',{file_path:'protected.txt',content:'MUTATED'},'forbidden-write')
      else if (i === 2) stream(res,[{content:'Child could not write.'}])
      else stream(res,[{content:'No mutation made.'}])
    },{skills:{watch:false}})
    await skill(workspace,'context: fork\nallowed-tools: [read]\n')
    await writeFile(join(workspace,'protected.txt'),'ORIGINAL')
    await (await app.createSession()).run('Use audit.')
    expect(await readFile(join(workspace,'protected.txt'),'utf8')).toBe('ORIGINAL')
    expect(JSON.stringify(requests[2]!.messages)).toMatch(/unknown tool|not available|not allowed|restricted/i)
  },30000)
  it('user-only fork activation is one-use and does not inject the body into the parent', async () => {
    const {app,workspace,requests} = await fixture((_q,res,i) => {
      if (i === 0) tool(res,'skill',{name:'audit',arguments:'exact'},'first')
      else if (i === 1) stream(res,[{content:'One child completed.'}])
      else if (i === 2) tool(res,'skill',{name:'audit',arguments:'exact'},'repeat')
      else stream(res,[{content:'Repeated execution refused.'}])
    },{skills:{watch:false}})
    await skill(workspace,'context: fork\nallowed-tools: []\ndisable-model-invocation: true\n','USER_ONLY_BODY $ARGUMENTS')
    const result = await (await app.createSession()).run('/audit exact')
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('USER_ONLY_BODY')
    expect(JSON.stringify(requests[1]!.messages)).toContain('USER_ONLY_BODY exact')
    const rows = outputs(result.events); expect(rows.map(r => r.isError === true)).toEqual([false,true])
  },30000)
  it('user-only authorization does not accept modified arguments', async () => {
    const {app,workspace,requests} = await fixture((_q,res,i) => i === 0
      ? tool(res,'skill',{name:'audit',arguments:'different'}) : stream(res,[{content:'Wrong arguments refused.'}]),{skills:{watch:false}})
    await skill(workspace,'context: fork\ndisable-model-invocation: true\n')
    const result = await (await app.createSession()).run('/audit exact')
    expect(requests).toHaveLength(2); expect(outputs(result.events)[0]?.isError).toBe(true)
  },30000)
  it('resource reads reuse only still-visible exact output, then disclose changed output', async () => {
    let path = ''
    const {app,workspace,requests} = await fixture(async (_q,res,i) => {
      if (i === 0) tool(res,'skill',{name:'audit'})
      else if (i === 1 || i === 2) tool(res,'skill_read',{name:'audit',path:'references/guide.md'},'resource-'+i)
      else if (i === 3) { await writeFile(path,'RESOURCE_CHANGED'); tool(res,'skill_read',{name:'audit',path:'references/guide.md'},'resource-changed') }
      else stream(res,[{content:'Updated reference loaded.'}])
    },{skills:{watch:false}})
    const root = await skill(workspace,'','Read references/guide.md as needed.')
    await mkdir(join(root,'references')); path=join(root,'references/guide.md');await writeFile(path,'RESOURCE_ORIGINAL')
    const result = await (await app.createSession()).run('Use the resource.')
    expect(requests).toHaveLength(5)
    const rows = outputs(result.events).map(r => JSON.stringify(r))
    expect(rows[1]).toContain('RESOURCE_ORIGINAL'); expect(rows[2]).toContain('same read result')
    expect(rows[2]).not.toContain('RESOURCE_ORIGINAL'); expect(rows[3]).toContain('RESOURCE_CHANGED')
    expect(outputs(result.events).some(r => r.isError)).toBe(false)
  },30000)
  it('revokes an admitted user-only fork when its definition changes before execution', async () => {
    let root = ''
    const {app,workspace,requests} = await fixture(async (_q,res,i) => {
      if (i === 0) {
        const file = join(root,'SKILL.md'); await writeFile(file,(await readFile(file,'utf8')).replace('ORIGINAL_BODY','REPLACED_BODY'))
        tool(res,'skill',{name:'audit',arguments:'exact'})
      } else stream(res,[{content:'Changed definition requires reinvocation.'}])
    },{skills:{watch:false}})
    root = await skill(workspace,'context: fork\ndisable-model-invocation: true\n','ORIGINAL_BODY')
    const result = await (await app.createSession()).run('/audit exact')
    expect(requests).toHaveLength(2); expect(outputs(result.events)[0]?.isError).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('REPLACED_BODY')
  },30000)
  it('cancels an active child request and does not continue on a late child response', async () => {
    const childStarted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const {app,workspace,requests} = await fixture(async (_q,res,i) => {
      if (i === 0) tool(res,'skill',{name:'audit'},'activate')
      else if (i === 1) { childStarted.resolve(); await release.promise; if (!res.destroyed) stream(res,[{content:'LATE_CHILD'}]) }
      else stream(res,[{content:'Fresh explicit work.'}])
    },{skills:{watch:false}})
    await skill(workspace,'context: fork\nallowed-tools: [read]\n')
    const session=await app.createSession(), controller=new AbortController()
    const running=session.run('Activate audit.',{signal:controller.signal})
    try {
      await childStarted.promise; controller.abort(new Error('fixture cancellation'))
      const result = await running
      expect(result.stopReason?.kind).toBe('aborted'); expect(requests).toHaveLength(2)
    } finally { release.resolve() }
    const next=await session.run('Proceed only with fresh explicit work.')
    expect(next.stopReason?.kind).toBe('completed');expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2]!.messages)).not.toContain('LATE_CHILD')
  },30000)

})
