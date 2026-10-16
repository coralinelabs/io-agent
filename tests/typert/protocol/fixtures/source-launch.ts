import { Context } from "../../../../src/library/runtime/vendor/cordis/index.ts"
import {
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
} from "../../../../src/library/runtime/protocol/index.ts"

class Goals extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote
  create(value: string): string {
    return value
  }

  @RemoteScope('agent')
  scoped(value: string): string {
    return value
  }
}

const methods = remoteMethods(new Goals(new Context()))
const actual = JSON.stringify(methods)
const expected = JSON.stringify([
  { method: 'create', invocation: { kind: 'direct' } },
  { method: 'scoped', invocation: { kind: 'context', context: 'agent' } },
])
if (actual !== expected) throw new Error(`unexpected Remote declarations: ${actual}`)
process.stdout.write(actual)
