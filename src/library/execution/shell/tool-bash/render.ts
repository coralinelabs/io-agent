/**
 * Model-facing result rendering for the bash tool.
 *
 * @module io-agent/tool-bash/render
 */

import { modelText } from "../../../context/text/index.ts"
import type { ShellProcessRead, ShellRunResult, ShellSandboxInfo, CollectedOutput } from "../shell/index.ts"
import type { SandboxMode } from "../../sandbox/sandbox/index.ts"
import { escalationHintMarker, sandboxDenialMarker } from "../../sandbox/sandbox/index.ts"

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return modelText('foundation/tool-bash-render/text-01', { value_1: String(output.text), value_2: String(output.spillPath ?? '(unavailable)') })
}

/**
 * A run's stdout, then a marked stderr section, each with its truncation notice.
 * @param result - the run's collected streams.
 * @returns the body, empty when both streams were.
 */
export function outputBody(result: Pick<ShellRunResult, 'stdout' | 'stderr'>): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  return body
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises;
 *   non-empty adds the same-turn escalation hint after a denial marker
 *   (default `[]`: no hint).
 * @returns the model-facing text: output body (or `(no output)`), then any timeout/signal/exit markers, each on its own line.
 */
export function renderResult(
  result: ShellRunResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
  let body = outputBody(result)
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // Keep the exit marker last because parseExitStatus anchors there.
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    // Hint only when the composition exposes escalation, before the final exit marker.
    if (escalationModes.length > 0) {
      markers.push(escalationHintMarker('command'))
    }
  }
  // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape a foreground call that outlasted the default wait: the output so far,
 * then the marker naming the background job it continues as.
 * @param output - the body rendered so far (empty when there was none).
 * @param afterMs - how long the command ran in the foreground.
 * @param jobId - the job it continues as.
 * @returns the model-facing text.
 */
export function renderDetached(output: string, afterMs: number, jobId: string): string {
  const marker = modelText('runtime/tool-bash-index/text-18', { seconds: String(Math.round(afterMs / 1000)), job_id: jobId })
  if (output.length === 0) return marker
  return `${output}${output.endsWith('\n') ? '' : '\n'}${marker}`
}

/**
 * Shape one background-process read into the `job_output` delta the model
 * sees: the incremental delta, plus the lossy-read notice (with full-stream
 * spill paths) when in-memory truncation dropped unread bytes. Empty-delta
 * rendering (`(no new output)`) is the generic job controller's job.
 * @param read - one incremental read from the process handle.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderProcessRead(
  read: ShellProcessRead,
  sandbox?: ShellSandboxInfo,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const notices: string[] = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path): path is string => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(modelText('runtime/tool-bash-render/text-01', { value_1: String(sandbox.mode) }))
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) {
      notices.push(escalationHintMarker('command'))
    }
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/**
 * The exit-status parse is the shared marker-contract half of the shell-tool
 * rendering story, owned by `io-agent/shell` so `dsh-tool-pwsh` reuses
 * it (its renderer emits the same markers). Re-exported here to keep
 * `../src/render.ts` a single import root for bash-tool consumers.
 */
export { parseExitStatus, type ParsedExitStatus } from "../shell/index.ts"
