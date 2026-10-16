/** Bounded, request-only payload recovery over dsh's unchanged compaction transaction. */
import { createHash } from 'node:crypto'
import BasicCompaction from "./basic/index.ts"
import type { SummarizationInput, SummaryResult } from "./basic/index.ts"
import type { Agent } from "../../runtime/agents/index.ts"
import { LlmError } from "../../model/llm/index.ts"
import type { Message } from "../../model/llm/index.ts"
import { modelText } from "../text/index.ts"

declare module "../../session/journal/types.ts" {
  interface SessionEventMap {
    /** Auxiliary request adjustment only. Never a change to the conversation surface. Journaled under its name from before io-agent. */
    'pluto/compaction-recovery': {
      attempt: number
      bytesBefore: number
      bytesAfter: number
      requestSha256: string
    }
  }
}

/** Match explicit payload rejection, not token overflow, auth, overload, or arbitrary task prose. */
export function isPayloadLimit(error: unknown): boolean {
  const seen = new Set<unknown>()
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current)
    if (current instanceof LlmError && (current.failure.status === 413 || current.code === 'HTTP_413'
      || /^(?:PAYLOAD_TOO_LARGE|REQUEST_TOO_LARGE|FUNCTION_PAYLOAD_TOO_LARGE)$/i.test(current.code)
      || /request entity too large|function_payload_too_large/i.test(current.message))) return true
  }
  return false
}

/** Keep every message and call/result identity; trim only older successful plain-text tool evidence. */
export function reduceSummaryPayload(messages: readonly Message[], limit: number): Message[] | null {
  const groups = messages.filter(m => m.role === 'assistant' && m.content.some(b => b.type === 'tool-call'))
  const latest = new Set(groups.at(-1)?.content.flatMap(b => b.type === 'tool-call' ? [b.id] : []) ?? [])
  const marker = modelText('compaction/payload-reduced')
  const reduced = messages.map((message) => {
    if (message.role !== 'tool' || message.isError || latest.has(message.toolCallId)
      || message.content.some(block => block.type !== 'text')) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'text') return block
      const points = Array.from(block.text)
      if (points.length <= limit * 2) return block
      const text = points.slice(0, Math.floor(limit * 0.75)).join('') + marker + points.slice(-Math.ceil(limit * 0.25)).join('')
      if (Buffer.byteLength(JSON.stringify(text)) >= Buffer.byteLength(JSON.stringify(block.text))) return block
      changed = true
      return { ...block, text }
    })
    return changed ? { ...message, content } : message
  })
  return Buffer.byteLength(JSON.stringify(reduced)) < Buffer.byteLength(JSON.stringify(messages)) ? reduced : null
}

export default class IoAgentCompaction extends BasicCompaction {
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    let current = input
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      try { return await super.summarize(current, agent, signal) }
      catch (error) {
        signal?.throwIfAborted()
        if (attempt >= 2 || !isPayloadLimit(error)) throw error
        const messages = reduceSummaryPayload(current.messages, 2048 >> attempt)
        if (messages === null) throw error
        const before = JSON.stringify(current), after = JSON.stringify({ ...current, messages })
        if (Buffer.byteLength(after) >= Buffer.byteLength(before)) throw error
        agent.session.append('pluto/compaction-recovery', { attempt: attempt + 1,
          bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after),
          requestSha256: createHash('sha256').update(after).digest('hex') })
        current = { ...current, messages }
      }
    }
  }
}
