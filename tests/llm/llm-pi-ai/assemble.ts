/**
 * Test helper: drive `ctx.llm.stream()` through a `BlockAssembler` and return
 * the assembled message + usage + finish reason. This exercises the same
 * streaming path production uses (the loop), rather than a service-level
 * one-shot convenience method.
 */

import { BlockAssembler } from "../../../src/library/model/llm/index.ts"
import type { Context } from "../../../src/library/runtime/vendor/cordis/index.ts"
import type { FinishReason, GenerateOptions, Message, TokenUsage } from "../../../src/library/model/llm/index.ts"

export interface AssembledResult {
  message: Message
  usage?: TokenUsage
  finish: FinishReason
}

export async function assemble(ctx: Context, options: Omit<GenerateOptions, 'provider'> & { provider?: string }): Promise<AssembledResult> {
  const assembler = new BlockAssembler()
  const request = { provider: 'deepseek', ...options }
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  return {
    message: assembler.message({
      kind: 'model',
      provider: request.provider,
      model: request.model,
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }),
    ...assembler.usage !== undefined ? { usage: assembler.usage } : {},
    finish: assembler.finish,
  }
}
