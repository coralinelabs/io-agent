/**
 * Prompt-cache stability on the default runtime path, measured against a
 * deterministic prefix-caching provider (see prefix-cache-fixture.ts), plus
 * the cache and compaction metrics io-agent reports for the same session.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import type { Agent } from "../../../src/library/runtime/agents/index.ts"
import * as McpClient from "../../../src/library/mcp/mcp-client/index.ts"
import type { IoAgentSession, PrefixBreakCause, SessionMetrics } from "../../../src/index.ts"
import { stream, tool, tools } from './fixture.ts'
import type { Usage } from './fixture.ts'
import { CACHE_BLOCK_TOKENS, compareToolAppend, comparePrefix, prefixCacheFixture, TOKEN_BYTES } from './prefix-cache-fixture.ts'
import type { PrefixCacheRow } from './prefix-cache-fixture.ts'

const mcpServer = fileURLToPath(new URL('./fixtures/mcp-45.mjs', import.meta.url))

/**
 * Every place a main request may stop extending the previous one byte for
 * byte. Each entry names the backlog item that removes it; delete an entry
 * when that lands (the spec fails while a declared break no longer breaks).
 */
const DECLARED_BREAKS = [
  // Plan-mode toggles are not breaks: plan policy lives in the runtime-context
  // snapshot, so both toggles below must extend. The late MCP connect is not a
  // break either: it is a declared tool append (DECLARED_TOOL_APPENDS).
  // Inherent: pressure relief rewrites history once, by design.
  { event: 'pressure-prune', causes: ['prune'] },
  // The same pressure pass first stubs the newly aged results, then summarises.
  { event: 'summary-compaction', causes: ['prune', 'compaction'] },
] as const satisfies readonly { event: string; causes: readonly PrefixBreakCause[] }[]

/**
 * Where a main request's tool list grows mid-session. A tool-set change
 * cannot extend byte for byte on any provider: every chat template renders the
 * tool list ahead of the conversation (Anthropic: tools, system, messages;
 * OpenAI harmony, Qwen and DeepSeek templates: system, tools, messages), so at
 * least the messages after the list are uncached. A per-session tool freeze
 * advertises dead tools or hides new ones, and always-present bridges would
 * cost their schemas in every request plus a tool_search round trip per MCP
 * call. So the minimum is what io-agent does:
 * append the new tools after the previous list (never mid-list by name) and
 * keep the system prompt as the session recorded it, stating the late
 * server's instructions and resource list in the runtime-context snapshot. The
 * request then keeps every earlier byte up to the end of the old list, the
 * messages extend the previous request's, and io-agent records one `tools` break.
 */
const DECLARED_TOOL_APPENDS = [
  { event: 'mcp-late', causes: ['tools'],
    appended: ['list_mcp_resource_templates', 'list_mcp_resources', 'mcp__fixture__echo', 'read_mcp_resource'] },
] as const satisfies readonly { event: string; causes: readonly PrefixBreakCause[]; appended: readonly string[] }[]
type BreakEvent = typeof DECLARED_BREAKS[number]['event'] | typeof DECLARED_TOOL_APPENDS[number]['event']

/** Session-wide cache target. */
const TARGET_HIT_RATE = 0.98
const WINDOW = 40960
/**
 * The phase-A 98% bound is a content ratio as much as a stability check:
 * each steady step appends about 200 new, uncached tokens, so the rate reaches
 * 98% only while the stable prefix (system prompt, tools and the padded
 * projectRules() AGENTS.md) keeps the first request above this size.
 */
const MIN_STABLE_PREFIX_TOKENS = 9000

/** What the fixture caches for a request that extends `previous` byte for byte. */
const idealCached = (previous: PrefixCacheRow): number =>
  Math.floor(Math.floor(previous.bytes / TOKEN_BYTES) / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS

type Step =
  | { kind: 'calls'; calls: (readonly [string, object])[] }
  | { kind: 'text'; text: string }
  | { kind: 'dynamic'; next: () => Promise<Step> }

const calls = (...list: (readonly [string, object])[]): Step => ({ kind: 'calls', calls: list })
const text = (value: string): Step => ({ kind: 'text', text: value })

/** A long, varied project instruction file: realistic weight for the stable prefix. */
function projectRules(): string {
  const areas = ['parser', 'scheduler', 'storage layer', 'HTTP client', 'CLI', 'test harness', 'build scripts', 'telemetry']
  const verbs = ['Keep', 'Document', 'Validate', 'Review', 'Benchmark', 'Isolate', 'Version', 'Log']
  const lines = ['# Project rules', '', 'These rules apply to every change in this repository.', '']
  for (let section = 0; section < 16; section++) {
    lines.push(`## ${areas[section % areas.length]} (${section + 1})`, '')
    for (let rule = 0; rule < 8; rule++) {
      lines.push(`- ${verbs[(section + rule) % verbs.length]} every ${areas[(section * 3 + rule) % areas.length]} change with a focused test; rule ${section + 1}.${rule + 1} exists because regressions here were expensive.`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Plain ASCII lines whose rendered `read` result is about `tokens` × 4 characters. */
function logFile(tokens: number, tag: string): string {
  const line = `${tag} worker=7 status=ok elapsed=12ms message="request handled without retry" shard=3`
  const lines: string[] = []
  let rendered = 60
  for (let n = 1; rendered < tokens * 4; n++) {
    lines.push(`${line} #${n}`)
    rendered += String(n).length + 2 + line.length + String(n).length + 3
  }
  return lines.join('\n') + '\n'
}

describe('prompt-cache stability on the default runtime path and session metrics', () => {
  it('reports a measured 0% hit rate as 0, refolds identical metrics on resume, and counts absent provider cache fields as unreported', async () => {
    const f = await prefixCacheFixture((_request, response, index, usage) => {
      if (index === 0) tool(response, 'read', { file_path: 'a.txt' }, 'read-a', usage)
      // The third request's provider sends usage without any cache field.
      else if (index === 2) stream(response, [{ content: 'Done.' }], 'stop', { prompt_tokens: usage['prompt_tokens'], completion_tokens: 12 })
      else stream(response, [{ content: 'Done.' }], 'stop', usage)
    }, { model: { contextWindow: WINDOW, promptCacheKey: false } })
    await writeFile(join(f.workspace, 'a.txt'), 'alpha\n')
    const session = await f.app.createSession({ id: 'zero-hit' })
    expect(session.metrics().promptCache).toMatchObject({ hitRate: null, all: { requests: 0 }, last: null })

    const result = await session.run('Read a.txt.')
    expect(f.rows.map(row => row.key)).toEqual([undefined, undefined])
    const usage = result.events.flatMap(event => event.type === 'assistant/message' ? [event.data.usage] : [])
    expect(usage[0]).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(result.metrics.promptCache).toMatchObject({ hitRate: 0, warmHitRate: 0, all: { requests: 2, cacheReadTokens: 0 },
      unreportedRequests: 0, breaks: { total: 0 } })
    expect(result.metrics.promptCache.all.promptTokens).toBe(f.rows[0]!.promptTokens + f.rows[1]!.promptTokens)
    expect(result.metrics).toEqual(session.metrics())
    expect(result.metrics.context.thresholdTokens).toBe(Math.floor(WINDOW * 0.8))

    await session.close()
    const resumed = await f.app.resumeSession('zero-hit')
    const after = resumed.metrics()
    expect(after.promptCache).toEqual(result.metrics.promptCache)
    expect(after.tokens).toEqual(result.metrics.tokens)
    expect(after.context).toEqual(result.metrics.context)
    // A new loop instance is counted, never scored as steady and, with no recorded cause, not a break.
    const next = await resumed.run('Again.')
    expect(next.metrics.promptCache).toMatchObject({ resumes: 1, breaks: { total: 0 }, steady: after.promptCache.steady })
    // A provider that sends no cache field is not a measured 0% hit.
    expect(next.metrics.promptCache.all.requests).toBe(2)
    const [unreported] = next.events.flatMap(event => event.type === 'assistant/message' ? [event.data.usage] : [])
    expect(unreported).toMatchObject({ cacheReported: false })
    expect(unreported).not.toHaveProperty('cacheReadTokens')
    expect(next.metrics.promptCache).toMatchObject({ unreportedRequests: 1, all: { cacheReadTokens: 0 } })
  }, 60000)

  it('extends every main request byte for byte except at declared breaks, and io-agent reports the same hits and breaks', async () => {
    let context!: Context
    let root!: Agent
    let session!: IoAgentSession
    const script: Step[] = []
    const declared = new Map<number, BreakEvent>()
    /** Declare that the next main request opens `event`. */
    const declare = (event: BreakEvent): void => { declared.set(f.rows.filter(row => row.purpose === 'agent').length, event) }
    let callId = 0
    const reply = async (response: Parameters<typeof stream>[0], step: Step, usage: Usage): Promise<void> => {
      if (step.kind === 'dynamic') return reply(response, await step.next(), usage)
      if (step.kind === 'text') return stream(response, [{ content: step.text }], 'stop', usage)
      tools(response, step.calls.map(([name, args]) => [name, args, `call_${++callId}`] as const), usage)
    }
    const f = await prefixCacheFixture(async (_request, response, index, usage) => {
      if (f.purposes[index] === 'compaction') return stream(response, [{ content: '## Current Work\nSurveying logs; keep the project rules.' }], 'stop', usage)
      const step = script.shift()
      if (step === undefined) throw new Error(`unscripted main request ${index}`)
      await reply(response, step, usage)
    }, {
      model: { contextWindow: WINDOW },
      configure: (ctx) => {
        context = ctx
        ctx.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession === undefined) root = agent })
      },
    })
    const { workspace } = f
    await writeFile(join(workspace, 'AGENTS.md'), projectRules())
    await mkdir(join(workspace, 'src'))
    for (let i = 0; i < 6; i++) await writeFile(join(workspace, 'src', `f${i}.ts`), `export const v${i} = ${i}\n`.repeat(12))
    await mkdir(join(workspace, 'sub'))
    await writeFile(join(workspace, 'sub', 'AGENTS.md'), '# Sub rules\nAlways say SUBRULE.\n')
    await writeFile(join(workspace, 'sub', 'b.txt'), 'beta\n')
    await mkdir(join(workspace, '.pluto/skills/demo'), { recursive: true })
    await writeFile(join(workspace, '.pluto/skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo review checklist.\n---\nDEMO_SKILL_BODY: check the diff, then the tests.\n')
    // Offered only once the late MCP server brings its echo tool: the agent's tool set changes mid-session.
    await mkdir(join(workspace, '.pluto/skills/echo-helper'), { recursive: true })
    await writeFile(join(workspace, '.pluto/skills/echo-helper/SKILL.md'),
      '---\nname: echo-helper\ndescription: ECHO_HELPER_ENTRY wraps the fixture echo tool.\nrequires-tools: [mcp__fixture__echo]\n---\nUse mcp__fixture__echo.\n')
    session = await f.app.createSession({ id: 'prefix-cache' })

    // Phase A: an ordinary multi-turn coding session.
    script.push(
      calls(['read', { file_path: 'src/f0.ts' }], ['read', { file_path: 'src/f1.ts' }]),
      calls(['grep', { pattern: 'v2', path: '.' }]),
      calls(['read', { file_path: 'sub/b.txt' }]),
      calls(['skill', { name: 'demo' }]),
      text('Turn one done.'),
    )
    await session.run('Read f0 and f1, grep for v2, read sub/b.txt, then use the demo skill.')
    expect(unitText(f.rows.at(-1)!.units)).not.toContain('ECHO_HELPER_ENTRY')
    expect(JSON.stringify(f.rows.at(-1)!.units)).toContain('SUBRULE')
    expect(JSON.stringify(f.rows.at(-1)!.units)).toContain('DEMO_SKILL_BODY')
    script.push(calls(['bash', { command: 'echo hi', description: 'echo' }]), text('Turn two done.'))
    await session.run('Now run echo.')

    // Plan-mode toggles ride the runtime-context snapshot: undeclared, so these requests must extend.
    expect(context.planMode.set(root, true)).toBe('committed')
    script.push(calls(['read', { file_path: 'src/f2.ts' }]), text('Plan drafted.'))
    session.send('Plan the next change.')
    await session.whenIdle()
    expect(context.planMode.set(root, false)).toBe('committed')
    script.push(calls(['read', { file_path: 'src/f3.ts' }], ['read', { file_path: 'src/f4.ts' }]), text('Turn four done.'))
    session.send('Implement it.')
    await session.whenIdle()

    await context.plugin(McpClient, { transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [mcpServer, 'normal'],
      cwd: workspace, failOnStartupError: true, reconnect: { enabled: false } }).await()
    // Not a break: a declared tool append (see DECLARED_TOOL_APPENDS).
    declare('mcp-late')
    script.push(calls(['mcp__fixture__echo', { text: 'MCP_LATE' }]), text('Turn five done.'))
    await session.run('Echo through the fixture server.')
    script.push(calls(['read', { file_path: 'src/f5.ts' }]), text('Turn six done.'))
    await session.run('Finish the review.')

    // A goal round: the driver starts a new request series whose prompt still
    // extends the previous one, so it is neither a declared nor a recorded break.
    const beforeGoal = root.session.seq
    script.push(
      calls(['create_goal', { objective: 'Confirm the review is complete.' }]),
      text('Goal set.'),
      { kind: 'dynamic', next: () => {
        const goal = context.goals.get(root)
        if (goal === undefined) throw new Error('create_goal left no goal')
        return Promise.resolve(calls(['update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }]))
      } },
      text('Goal complete.'),
    )
    await session.run('Set a goal to confirm the review is complete.')
    for (let wait = 0; wait < 400 && (script.length > 0 || context.goals.get(root)?.phase !== 'complete'); wait++) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await session.whenIdle()
    expect(context.goals.get(root)?.phase).toBe('complete')
    expect(root.session.snapshotEvents().filter(event => event.seq > beforeGoal && event.type === 'request/header')
      .map(event => event.type === 'request/header' ? event.data.reason : undefined)).toEqual(['series'])
    const phaseA = session.metrics()
    const phaseAMain = f.rows.filter(row => row.purpose === 'agent').length

    // Phase B: fill the window from measured occupancy, then relieve pressure twice.
    const threshold = phaseA.context.thresholdTokens!
    expect(threshold).toBe(Math.floor(WINDOW * 0.8))
    const occupancy = (): number => session.metrics().context.tokens
    const readOf = async (name: string, tokens: number): Promise<Step> => {
      await writeFile(join(workspace, 'logs', name), logFile(tokens, name))
      // An explicit limit reads past io-agent's 16 KB default window, up to the 50 KB cap.
      return calls(['read', { file_path: `logs/${name}`, limit: 2000 }])
    }
    await mkdir(join(workspace, 'logs'))
    const GAP = 900, FILLER = 1500, CALL = 60
    const room = threshold - GAP - phaseA.context.tokens
    const big = Math.min(5500, Math.floor((room - 5 * FILLER) / 2))
    expect(big, `stable prefix grew: only ${room} tokens of room below the ${threshold}-token threshold`).toBeGreaterThanOrEqual(3000)
    let fillers = 0
    const fill: Step = { kind: 'dynamic', next: async () => {
      const remaining = threshold - GAP - occupancy() - CALL
      if (remaining < 200 && fillers >= 4) return text('Survey done.')
      expect(remaining, `filler ${fillers} does not fit below the threshold`).toBeGreaterThanOrEqual(200)
      fillers++
      script.unshift(fill)
      return readOf(`filler-${fillers}.log`, Math.min(FILLER, remaining))
    } }
    script.push({ kind: 'dynamic', next: () => readOf('big-1.log', big) }, { kind: 'dynamic', next: () => readOf('big-2.log', big) }, fill)
    await session.run('Survey the service logs.')
    expect(session.metrics().context).toMatchObject({ compactions: 0, prunedResults: 0 })

    script.push({ kind: 'dynamic', next: async () => {
      const cross = threshold - occupancy() + 300
      expect(cross, 'the crossing read must stay below the pruner threshold').toBeLessThanOrEqual(1900)
      declare('pressure-prune')
      return readOf('cross.log', cross)
    } }, text('Pruned.'))
    await session.run('Check the crossing log.')
    // One pressure prune, landing under the watermark in this one break: results over 2,048
    // characters beyond the newest 5 tool groups (big-1, big-2 and the first filler) become one-line
    // stubs and the demo skill, last requested more than 10 tool groups ago, becomes the skill-removed
    // marker; the session is still above the watermark, so the smaller old fillers become stubs too.
    expect(session.metrics().context).toMatchObject({ prunedResults: 11, compactions: 0 })
    const afterPrune = unitText(f.rows.findLast(row => row.purpose === 'agent')!.units)
    for (const name of ['big-1.log', 'big-2.log', 'filler-1.log']) {
      expect(afterPrune).toContain(`[Pruned older read result to save context. Call: file_path="logs/${name}", limit=2000.`)
    }
    expect(afterPrune).toContain('[Skill "demo" was pruned from context')
    expect(afterPrune).not.toContain('DEMO_SKILL_BODY')

    // The prune landed under the watermark, so climb back toward the threshold with up to three reads, close
    // enough for one huge read to cross by more than the results it ages out can free: the pass stubs those, and
    // the summary relieves the rest.
    let climbs = 0
    const climb: Step = { kind: 'dynamic', next: async () => {
      const short = threshold - 6000 - occupancy() - CALL
      if (short < 200 || climbs >= 3) return text('Climbed.')
      climbs++
      script.unshift(climb)
      return readOf(`climb-${climbs}.log`, Math.min(11000, short))
    } }
    script.push(climb)
    await session.run('Read the remaining logs.')

    script.push({ kind: 'dynamic', next: async () => {
      const huge = threshold - occupancy() + 5000
      expect(huge, 'the post-prune read must fit one read').toBeLessThanOrEqual(11500)
      declare('summary-compaction')
      return readOf('huge.log', huge)
    } }, text('Compacted.'))
    const last = await session.run('Inspect the huge log.')
    expect(script).toHaveLength(0)
    const metrics = last.metrics

    // 1. Every main request extends the previous main request byte for byte, except exactly at the declared events.
    const main = f.rows.filter(row => row.purpose === 'agent')
    const table = main.map((row, index) => {
      const previous = main[index - 1]
      const comparison = previous === undefined ? undefined : comparePrefix(previous.units, row.units)
      return { index, prompt: row.promptTokens, cached: row.cachedTokens, extends: comparison?.extends ?? null,
        declared: declared.get(index) ?? '', divergence: comparison?.divergence }
    })
    const report = (): string => JSON.stringify(table.map(({ divergence, ...row }) => divergence === undefined ? row : { ...row, divergence }), null, 1)
    for (const row of table.slice(1)) {
      expect(row.extends, `main request ${row.index} ${row.declared === '' ? 'broke the prefix' : `was declared ${row.declared} but extended`}\n${report()}`)
        .toBe(row.declared === '')
    }
    const indexOf = (event: BreakEvent): number => [...declared].find(([, name]) => name === event)![0]
    expect([...declared.values()]).toEqual(['mcp-late', ...DECLARED_BREAKS.map(entry => entry.event)])

    // 1b. The late MCP connect appends its tools after the previous list, keeps the recorded
    // system prompt, and states the server's instructions and resource list as runtime context.
    for (const entry of DECLARED_TOOL_APPENDS) {
      const at = indexOf(entry.event)
      const [previous, current] = [main[at - 1]!, main[at]!]
      const append = compareToolAppend(previous.units, current.units)
      expect(append, `${entry.event} did not append its tools\n${report()}`).toMatchObject({
        sameHeadFields: true, keepsTools: true, appended: [...entry.appended], messagesExtend: true })
      // The cached prefix reaches exactly the end of the old tool list (tools-first, as this fixture
      // serializes), or the system prompt plus the whole old list (system-first templates).
      expect(append.lcp).toBe(append.toolsEnd)
      expect(append.systemFirstLcp).toBe(append.systemAndToolsEnd)
      expect(current.units[1]).toBe(main[0]!.units[1])
      const tail = unitText(current.units.slice(previous.units.length))
      // The skill the new tool unlocks arrives as one replacement catalog appended after history,
      // inside the same declared tools break (asserted through the recorded causes below).
      expect(unitText(previous.units)).not.toContain('ECHO_HELPER_ENTRY')
      expect(tail).toContain('ECHO_HELPER_ENTRY')
      expect(unitText(current.units.slice(0, previous.units.length))).not.toContain('ECHO_HELPER_ENTRY')
      expect(tail).toContain('MCP server fixture now provides these instructions')
      expect(tail).toContain('MCP_ATTRIBUTED_INSTRUCTION_45')
      expect(tail).toContain('MCP resource servers now available: ["fixture"]')
      console.info(`prefix-cache: ${entry.event} cached ${current.cachedTokens} of ${current.promptTokens} tokens `
        + `(tools-first prefix ${append.lcp} bytes; system-first ${append.systemFirstLcp} bytes, `
        + `${Math.floor(Math.floor(append.systemFirstLcp / TOKEN_BYTES) / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS} tokens)`)
    }

    // 2. io-agent recorded the same breaks, with their causes.
    const recorded = [...DECLARED_TOOL_APPENDS, ...DECLARED_BREAKS]
      .map(entry => ({ requestIndex: indexOf(entry.event), causes: [...entry.causes] }))
      .sort((a, b) => a.requestIndex - b.requestIndex)
    expect(metrics.promptCache.breaks.recent.map(entry => ({ requestIndex: entry.requestIndex, causes: entry.causes })))
      .toEqual(recorded)
    expect(metrics.promptCache).toMatchObject({ unreportedRequests: 0, unexplainedMisses: 0, resumes: 0,
      all: { requests: main.length, promptTokens: sum(main, 'promptTokens'), cacheReadTokens: sum(main, 'cachedTokens') } })

    // 3. Phase A: io-agent's steady aggregate equals the fixture's own tally. Every undeclared main
    // request of the session cached its whole previous prompt (the fixture ideal): byte stability,
    // whatever the content.
    const steadyA = main.slice(1, phaseAMain).filter((_row, index) => !declared.has(index + 1))
    expect(phaseA.promptCache.steady).toEqual({ requests: steadyA.length, promptTokens: sum(steadyA, 'promptTokens'),
      cacheReadTokens: sum(steadyA, 'cachedTokens'), cacheWriteTokens: 0 })
    for (const row of table.slice(1).filter(entry => entry.declared === '')) {
      expect(row.cached, `main request ${row.index} cached less than its whole previous prompt\n${report()}`).toBe(idealCached(main[row.index - 1]!))
    }
    // The 98% target then depends only on how large the stable prefix is against each step's new content.
    expect(main[0]!.promptTokens, `stable prefix shrank to ${main[0]!.promptTokens} tokens: the phase-A 98% bound needs ${MIN_STABLE_PREFIX_TOKENS}. `
      + 'Pad projectRules() rather than lowering the target; this is content, not a cache regression.').toBeGreaterThanOrEqual(MIN_STABLE_PREFIX_TOKENS)
    expect(phaseA.promptCache.steadyHitRate, `phase A steady ${String(phaseA.promptCache.steadyHitRate)}, warm ${String(phaseA.promptCache.warmHitRate)}: `
      + `every steady request cached its whole previous prompt, so the appended content outgrew the stable prefix\n${report()}`)
      .toBeGreaterThanOrEqual(TARGET_HIT_RATE)

    // 4. The summariser replays the preceding main request byte for byte, so its call caches that whole
    // request. The same pressure pass stubbed filler-2 (the one result that aged past the newest 5 tool
    // groups) before summarising, but the summary reads each result that pass rewrote as it was sent.
    const summaries = f.rows.filter(row => row.purpose === 'compaction')
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    // Every request of the session, the summariser included, carries the same explicit effort in its head.
    for (const row of f.rows) expect(JSON.parse(row.units[0]!), `request ${row.index} head`).toMatchObject({ reasoning_effort: 'medium' })
    const before = f.rows.slice(0, summary.index).findLast(row => row.purpose === 'agent')!
    const replay = summary.units.slice(0, -1)
    expect(replay).toEqual(before.units)
    expect(summary.cachedTokens).toBe(idealCached(before))
    expect(unitText(replay)).toContain('filler-2.log worker=7')
    expect(unitText(replay)).not.toContain('[Pruned older read result to save context. Call: file_path="logs/filler-2.log", limit=2000.')
    expect(metrics.promptCache.compaction).toEqual({ requests: 1, promptTokens: summary.promptTokens, cacheReadTokens: summary.cachedTokens, cacheWriteTokens: 0 })

    // 5. Occupancy against the compaction threshold and the compaction counts.
    // Pruned results: 11 in the crossing pass (to the watermark), then the 2 it aged out (filler-2 among them) in
    // the pass that summarised.
    expect(metrics.context).toMatchObject({ contextWindow: WINDOW, thresholdTokens: threshold, compactions: 1, failedCompactions: 0, prunedResults: 13 })
    // Plan-mode toggles no longer count as system breaks, nor does a late MCP server's first
    // instructions: its tool append is the one `tools` break outside pressure relief.
    expect(metrics.promptCache.breaks.byCause).toMatchObject({ prune: 2, compaction: 1, tools: 1 })
    expect(metrics.promptCache.breaks.byCause.system ?? 0).toBe(0)
    expect(metrics.context.occupancy!).toBeLessThan(1)
    expect(metrics.context.peakOccupancy!).toBeGreaterThan(0.5)
    expect(metrics.context.peakPromptTokens).toBe(Math.max(...main.map(row => row.promptTokens)))
    logSummary(phaseA, metrics, main)
    if (process.env['PREFIX_CACHE_REPORT'] !== undefined) console.info(report(), JSON.stringify(metrics.promptCache.breaks.recent))
  }, 120000)
})

/** Every string in a request's canonical units, one per line: the text the model reads. */
function unitText(units: readonly string[]): string {
  const strings: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk)
  }
  for (const unit of units) walk(JSON.parse(unit))
  return strings.join('\n')
}

function sum(rows: readonly PrefixCacheRow[], key: 'promptTokens' | 'cachedTokens'): number {
  return rows.reduce((total, row) => total + row[key], 0)
}

function logSummary(phaseA: SessionMetrics, final: SessionMetrics, main: readonly PrefixCacheRow[]): void {
  const pct = (value: number | null): string => value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`
  console.info(`prefix-cache: ${main.length} main requests; phase A steady ${pct(phaseA.promptCache.steadyHitRate)} (warm ${pct(phaseA.promptCache.warmHitRate)}); `
    + `session steady ${pct(final.promptCache.steadyHitRate)}, warm ${pct(final.promptCache.warmHitRate)}; peak occupancy ${pct(final.context.peakOccupancy)}`)
}
