/**
 * Shared path resolution and regular-file validation for model-facing read tools.
 * @module io-agent/tool-fs/src/read-target
 */

import { modelText } from "../../context/text/index.ts"
import type { Context } from "../../runtime/vendor/cordis/index.ts"
import { FsError } from "../fs/index.ts"
import type { FsInfo, FsTarget } from "../fs/index.ts"
import type { ToolExecution } from "../../tools/index.ts"
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including session cwd and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(modelText('foundation/tool-fs-read-target/text-01', { value_1: String(target.displayPath) }), 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(modelText('foundation/tool-fs-read-target/text-02', { value_1: String(target.displayPath) }), 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}
