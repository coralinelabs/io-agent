/** Exercise the installed node-pty teardown with a quiet ConPTY pipe on every platform. */
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

interface QuietConpty {
  _useConptyDll: true
  _pty: number
  _pendingPtyInfo: object | undefined
  _clearConnectionTimeout(): void
  _inSocket: { destroy(): void }
  _outSocket: EventEmitter
  _ptyNative: { kill(pty: number, useConptyDll: boolean): void }
  _conoutSocketWorker: { dispose(): void }
}

// This module loads the native addon only in its constructor. Calling its real
// kill method with fake handles tests the installed patch without Windows APIs.
const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent.js') as {
  WindowsPtyAgent: { prototype: { kill(this: QuietConpty): void } }
}

describe('installed node-pty ConPTY cleanup', () => {
  it('starts draining after kill even when the output pipe stays silent', () => {
    const events: string[] = []
    const output = new EventEmitter()
    const dispose = vi.fn(() => { events.push('drain') })
    const kill = vi.fn(() => { events.push('kill') })
    const agent: QuietConpty = {
      _useConptyDll: true,
      _pty: 42,
      _pendingPtyInfo: {},
      _clearConnectionTimeout() { events.push('clear-timeout') },
      _inSocket: { destroy() { events.push('close-input') } },
      _outSocket: output,
      _ptyNative: { kill },
      _conoutSocketWorker: { dispose },
    }

    WindowsPtyAgent.prototype.kill.call(agent)

    expect(agent._pendingPtyInfo).toBeUndefined()
    expect(kill).toHaveBeenCalledExactlyOnceWith(42, true)
    expect(events).toEqual(['clear-timeout', 'close-input', 'kill', 'drain'])
    expect(dispose).toHaveBeenCalledOnce()

    // Late output must still restart the worker's drain timer.
    output.emit('data', Buffer.from('last output'))
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
