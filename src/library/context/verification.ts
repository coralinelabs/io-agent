/** Read-only completion review on the existing model seam. Unknown is never converted into a pass. */
import type { Context } from "../runtime/vendor/cordis/index.ts"
import type { Agent } from "../runtime/agents/index.ts"
import { BlockAssembler, createUserMessage } from "../model/llm/index.ts"
import type { ContentBlock, Message } from "../model/llm/index.ts"
import { modelText } from "./text/index.ts"
import type { ResolvedConnection } from "../model/connection.ts"
import { freezeSnapshot } from "../model/inspection.ts"

export interface VerificationResult {
  readonly status: 'passed' | 'needs-work' | 'unknown'
  readonly summary: string
  readonly findings: readonly string[]
  /** Session position reviewed; subsequent work invalidates any interpretation of this as a current verdict. */
  readonly throughSeq: number
}
export function parseVerification(text: string, throughSeq: number): VerificationResult {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification: expected object')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'findings,status,summary'
    || typeof row.status !== 'string' || !['passed', 'needs-work', 'unknown'].includes(row.status)
    || typeof row.summary !== 'string' || row.summary.trim().length === 0 || row.summary.length > 4000
    || !Array.isArray(row.findings) || row.findings.length > 32 || row.findings.some(v => typeof v !== 'string' || v.trim().length === 0 || v.length > 2000)
    || (row.status === 'passed' && row.findings.length > 0)) throw new Error('verification: invalid structured verdict')
  return freezeSnapshot({ status: row.status as VerificationResult['status'], summary: row.summary,
    findings: row.findings as string[], throughSeq })
}
function textReviewable(blocks: readonly ContentBlock[]): boolean {
  return blocks.every((block) => {
    switch (block.type) {
      case 'text': case 'reasoning': case 'tool-call': return true
      default: return false // Non-text and future block types need explicit review support.
    }
  })
}
export async function verifyCompletion(
  ctx: Context, agent: Agent, connection: ResolvedConnection, signal?: AbortSignal,
): Promise<VerificationResult> {
  signal?.throwIfAborted()
  return agent.runMaintenance(async (ownerSignal) => {
    const abort = signal === undefined ? ownerSignal : AbortSignal.any([ownerSignal, signal])
    abort.throwIfAborted()
    const throughSeq = agent.session.seq
    const history = agent.session.deriveMessages()
    if (!history.every(message => textReviewable(message.content))) return freezeSnapshot({ status: 'unknown',
      summary: 'Verification cannot review non-text evidence without explicit content support.', findings: [], throughSeq })
    const transcript = history.map(({ source, ...message }) => ({ ...message,
      source: source.kind === 'model' ? { kind: source.kind, provider: source.provider, model: source.model } : source }))
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({ throughSeq, messages: transcript }) }],
      source: { kind: 'plugin', plugin: 'io-agent-verification' },
    })]
    try {
      const assembler = new BlockAssembler()
      let terminal = false
      for await (const chunk of ctx.llm.stream({ provider: connection.route, model: connection.model,
        system: modelText('verification/instruction'), messages, tools: [], maxTokens: Math.min(2048, connection.maxTokens), sessionId: agent.id, purpose: 'verification', signal: abort })) {
        abort.throwIfAborted()
        if (chunk.type === 'finish') terminal = true
        assembler.push(chunk)
      }
      abort.throwIfAborted()
      if (!terminal || assembler.finish.kind !== 'stop') throw new Error(`verification ended with ${assembler.finish.kind}`)
      const blocks = assembler.blocks()
      if (blocks.some(b => b.type !== 'text' && b.type !== 'reasoning')) throw new Error('verification returned non-text content')
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
      const result = parseVerification(text, throughSeq)
      if (agent.session.seq !== throughSeq) return freezeSnapshot({ status: 'unknown',
        summary: 'The session changed during verification; this is not a current completion verdict.', findings: [], throughSeq })
      return result
    } catch (_error) {
      abort.throwIfAborted()
      return freezeSnapshot({ status: 'unknown', summary: 'Verification could not establish a valid result.', findings: [], throughSeq })
    }
  })
}
