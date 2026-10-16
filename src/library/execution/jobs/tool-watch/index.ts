/**
 * Model-facing `watch`, `watch_list` and `watch_cancel` over `ctx.background`:
 * wait for a condition or a time without holding a turn open. Every watcher
 * has a deadline and wakes its agent exactly once.
 * @module io-agent/tool-watch
 */

import { modelText } from '../../../context/text/index.ts'
import type { Context } from '../../../runtime/vendor/cordis/index.ts'
import { defineTool } from '../../../tools/index.ts'
import type { GenericCallView } from '../../../tools/index.ts'
import type {} from '../background/index.ts'
import { describeCondition } from '../background/index.ts'
import type { WatcherRecord, WatchRequest } from '../background/index.ts'

export const name = 'tool-watch'
export const inject = ['tools', 'background']

/** What a watcher looks like to the model. */
interface PublicWatcher {
  id: string
  condition: WatcherRecord['condition']['kind']
  state: WatcherRecord['state']
  waits_for: string
  deadline: string
  result?: string
  note?: string
}

const WATCHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    condition: { type: 'string', required: true, enum: ['time', 'job', 'output', 'pid', 'file', 'url'] },
    state: { type: 'string', required: true, enum: ['armed', 'fired', 'expired', 'cancelled'] },
    waits_for: { type: 'string', required: true },
    deadline: { type: 'string', required: true },
    result: { type: 'string' },
    note: { type: 'string' },
  },
} as const

function publicWatcher(record: WatcherRecord): PublicWatcher {
  return {
    id: record.id, condition: record.condition.kind, state: record.state, waits_for: describeCondition(record), deadline: new Date(record.deadline).toISOString(),
    ...record.result === undefined ? {} : { result: record.result }, ...record.note === undefined ? {} : { note: record.note },
  }
}

function listLine(watcher: PublicWatcher): string {
  return watcher.state === 'armed'
    ? modelText('runtime/tool-watch-index/list-armed', { watch_id: watcher.id, waits_for: watcher.waits_for, deadline: watcher.deadline })
    : modelText('runtime/tool-watch-index/list-settled', { watch_id: watcher.id, state: watcher.state, result: watcher.result ?? '' })
}

function present(title: string, kind: NonNullable<GenericCallView['kind']>, rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

export function apply(ctx: Context): void {
  // A delegated agent's waits end with it: watchers belong to the main session, so it is not offered them.
  ctx.on('agent/created', ({ agent }) => {
    if (!ctx.background.serves(agent)) agent.ctx.tools.restrict({ deny: ['watch', 'watch_list', 'watch_cancel'] })
    return undefined
  })

  ctx.tools.register(defineTool({
    name: 'watch',
    description: modelText('runtime/tool-watch-index/description', { minutes: String(Math.round(ctx.background.defaultWatchMs / 60_000)) }),
    parameters: {
      job_id: { type: 'string', description: modelText('runtime/tool-watch-index/param-job-id') },
      pattern: { type: 'string', description: modelText('runtime/tool-watch-index/param-pattern') },
      pid: { type: 'number', description: modelText('runtime/tool-watch-index/param-pid') },
      path: { type: 'string', description: modelText('runtime/tool-watch-index/param-path') },
      url: { type: 'string', description: modelText('runtime/tool-watch-index/param-url') },
      at: { type: 'string', description: modelText('runtime/tool-watch-index/param-at') },
      minutes: { type: 'number', description: modelText('runtime/tool-watch-index/param-minutes') },
      note: { type: 'string', description: modelText('runtime/tool-watch-index/param-note') },
    },
    output: {
      schema: WATCHER_SCHEMA,
      render: (_args, watcher) => [{
        type: 'text',
        text: watcher.condition !== 'time'
          ? modelText('runtime/tool-watch-index/armed', { watch_id: watcher.id, waits_for: watcher.waits_for, deadline: watcher.deadline })
          : modelText('runtime/tool-watch-index/armed-time', { watch_id: watcher.id, deadline: watcher.deadline }),
      }],
    },
    async execute(args: WatchRequest, exec) {
      if (exec.agent === undefined) throw new Error(modelText('runtime/tool-watch-index/error-no-session'))
      return publicWatcher(await ctx.background.arm(exec.agent, args))
    },
    presentCall: (args: WatchRequest) => present('Watch', 'other',
      [args.job_id, args.pattern, args.pid, args.path, args.url, args.at, args.minutes].filter(value => value !== undefined).map(String).join(' ')),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_list',
    description: modelText('runtime/tool-watch-index/list-description'),
    parameters: {},
    output: {
      schema: { type: 'array', items: WATCHER_SCHEMA },
      render: (_args, watchers) => [{
        type: 'text',
        text: watchers.length === 0 ? modelText('runtime/tool-watch-index/list-empty') : watchers.map(listLine).join('\n'),
      }],
    },
    execute(_args, exec) {
      if (exec.agent === undefined) return Promise.resolve([])
      return Promise.resolve(ctx.background.watchersOf(new Set([String(exec.agent.id)])).map(publicWatcher))
    },
    presentCall: () => present('List watchers', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'watch_cancel',
    description: modelText('runtime/tool-watch-index/cancel-description'),
    parameters: {
      watch_id: { type: 'string', required: true, description: modelText('runtime/tool-watch-index/param-watch-id') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cancelled: { type: 'boolean', required: true }, watcher: { ...WATCHER_SCHEMA, required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.cancelled
          ? modelText('runtime/tool-watch-index/cancelled', { watch_id: value.watcher.id })
          : modelText('runtime/tool-watch-index/cancel-settled', { watch_id: value.watcher.id, state: value.watcher.state }),
      }],
    },
    async execute(args: { watch_id: string }, exec) {
      if (exec.agent === undefined) throw new Error(modelText('runtime/tool-watch-index/error-no-session'))
      const session = String(exec.agent.id)
      const before = ctx.background.watchersOf(new Set([session])).find(record => record.id === args.watch_id)
      const after = await ctx.background.cancelWatcher(session, args.watch_id)
      if (after === undefined) throw new Error(modelText('runtime/tool-watch-index/error-unknown-watcher', { watch_id: args.watch_id }))
      return { cancelled: before?.state === 'armed' && after.state === 'cancelled', watcher: publicWatcher(after) }
    },
    presentCall: (args: { watch_id: string }) => present(`Cancel watcher ${args.watch_id}`, 'other', args.watch_id),
  }))
}
