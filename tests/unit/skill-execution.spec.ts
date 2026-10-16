import { describe, expect, it } from 'vitest'
import { bindSkillArguments, splitSkillArguments } from '../../src/library/skills/activation.ts'
import { skillExecutionPolicy, validateSkillExecution } from '../../src/library/skills/execution-policy.ts'
import { narrowedToolFilter } from '../../src/library/agents/tool-subagent/tool-filter.ts'

describe('declared isolated skill execution', () => {
  it('keeps implicit inline skills unchanged', () => { expect(skillExecutionPolicy({})).toBeUndefined() })
  it('freezes explicit fork and exact tool restrictions', () => {
    const p = skillExecutionPolicy({ context: 'fork', 'allowed-tools': 'read, grep', arguments: ['path','mode'] })!
    expect(p).toEqual({ context: 'fork', allowedTools: ['read','grep'], argumentNames: ['path','mode'] })
    expect(Object.isFrozen(p.allowedTools)).toBe(true)
  })
  it.each([
    { context: 'other' }, { context: 'fork', 'allowed-tools': ['read','read'] },
    { context: 'fork', 'allowed-tools': ['*'] }, { context: 'inline', 'allowed-tools': ['read'] },
    { arguments: ['path','PATH'] }, { arguments: ['ARGUMENTS'] }, { arguments: ['a-b'] },
    { context: 'fork', 'allowed-tools': Array.from({length:129}, (_,i) => 't'+i) },
  ])('rejects invalid policy %s', data => { expect(() => skillExecutionPolicy(data)).toThrow() })
  it('rejects malformed provider policies instead of broadening them', () => {
    expect(() => validateSkillExecution({} as never)).toThrow()
    expect(() => validateSkillExecution({ context: 'fork', allowedTools: ['*'] })).toThrow()
  })
  it('an empty child allowlist means no inherited tools', () => { expect(narrowedToolFilter(undefined, [])).toEqual({ allow: [] }) })
  it('intersects configured allow and preserves deny rather than granting new permissions', () => {
    const configured = { allow: ['read','write'], deny: ['write'] }
    expect(narrowedToolFilter(configured, ['read','write','bash'])).toEqual({ allow:['read','write'], deny:['write'] })
    expect(narrowedToolFilter(configured, undefined)).toBe(configured)
  })
  it('reads an on-demand bridge name as the MCP tools behind it, still inside the configured allow', () => {
    const onDemand = ['mcp__x__a', 'mcp__x__b']
    expect(narrowedToolFilter(undefined, ['read', 'tool_search', 'tool_call'], onDemand)).toEqual({ allow: ['read', 'mcp__x__a', 'mcp__x__b'] })
    expect(narrowedToolFilter({ allow: ['read', 'mcp__x__b'] }, ['tool_call'], onDemand)).toEqual({ allow: ['mcp__x__b'] })
    // Without bridges presented to the parent, the name passes through for restrict() to judge.
    expect(narrowedToolFilter(undefined, ['tool_search'])).toEqual({ allow: ['tool_search'] })
  })
})

describe('literal, named skill bindings', () => {
  it('groups quotes and preserves ordinary Windows path backslashes', () => {
    expect(splitSkillArguments('"src/a b.ts" C:\\work\\input.ts \'literal $HOME\' ""')).toEqual(['src/a b.ts','C:\\work\\input.ts','literal $HOME',''])
  })
  it('does not recursively interpolate caller data or evaluate shell syntax', () => {
    const raw = '"$MODE $(touch NEVER)" safe'
    expect(bindSkillArguments('$PATH | $MODE | $ARGUMENTS | ${HERMES_SKILL_DIR} | ${CLAUDE_SESSION_ID} | $UNKNOWN', raw,
      { argumentNames:['path','mode'], skillDirectory:'/skills/${CLAUDE_SESSION_ID}', sessionId:'session' }))
      .toBe('$MODE $(touch NEVER) | safe | '+raw+' | /skills/${CLAUDE_SESSION_ID} | session | $UNKNOWN')
  })
  it('substitutes missing named arguments as empty but never truncates the raw argument text', () => {
    expect(bindSkillArguments('$A:$B/$ARGUMENTS', 'one', {argumentNames:['a','b']})).toBe('one:/one')
  })
  it('does not parse quotes when there are no named parameters', () => {
    expect(bindSkillArguments('$ARGUMENTS', 'unclosed "')).toBe('unclosed "')
    expect(() => bindSkillArguments('$NAME', 'unclosed "', {argumentNames:['name']})).toThrow('unclosed quote')
  })
  it('only expands explicitly supplied directory/session tokens', () => {
    expect(bindSkillArguments('${IO_AGENT_SKILL_DIR} $HOME ${CLAUDE_SESSION_ID}', undefined, {skillDirectory:'/literal'}))
      .toBe('/literal $HOME ${CLAUDE_SESSION_ID}')
    // the name from before io-agent, for skills written then
    expect(bindSkillArguments('${PLUTO_SKILL_DIR} ${PLUTO_SESSION_ID} ${IO_AGENT_SESSION_ID}', undefined, {skillDirectory:'/d', sessionId:'s'}))
      .toBe('/d s s')
  })
})
