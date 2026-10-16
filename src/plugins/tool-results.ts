/**
 * io-agent's tool-result pruning policy and its wiring of tool-owned result
 * formats into the generic pruner, plus the recall pointers a stub and a
 * compaction checkpoint carry: how a loaded skill body names its skill,
 * how a spilled result splits into its preview and retrieval notice, which
 * tools end their results with an exit or signal marker, and which read an
 * "unchanged" notice points at. The pruner stays free of the skill, spill,
 * shell and read modules; each format stays with the module that writes it.
 */
import type { ToolResultFormats, ToolResultPruneConfig } from "../library/context/compaction/tool-result-pruner/index.ts"
import type { CheckpointRange } from "../library/context/compaction/basic/index.ts"
import { modelText } from "../library/context/text/index.ts"
import type { SessionSeq } from "../library/session/journal/index.ts"
import { skillContentName } from "../library/skills/skill/index.ts"
import { SKILL_TOOL_NAME } from "../library/skills/tool-skill/history.ts"
import { splitSpillNotice } from "../library/output/policy/notice.ts"
import { exitMarkerOf } from "../library/execution/shell/shell/render.ts"
import { unchangedReadPointers } from "../library/filesystem/tool-fs/read.ts"

/**
 * A stub's pointer to its full result through the `recall` tool,
 * in recall's own pointer grammar.
 * @param seq - the journal event holding the recorded result.
 * @returns the pointer sentence.
 */
export function recallLogPointer(seq: SessionSeq): string {
  return modelText('compaction/pruned-tool-result-recall-pointer', { pointer: modelText('tools/recall/pointer-seq', { seq }) })
}

/**
 * A checkpoint's last section: the `recall` calls that list and return the
 * messages and results it condensed, in recall's own
 * pointer grammar.
 * @param range - the smallest and largest condensed surface seq.
 * @returns the section text.
 */
export function recallCheckpointLog(range: CheckpointRange): string {
  return modelText('compaction/checkpoint-log', {
    range: modelText('tools/recall/pointer-range', { from: range.from, to: range.to }),
    event: modelText('tools/recall/pointer-seq', { seq: '<number>' }),
  })
}

/**
 * Formats of the `skill`, spill-policy and `bash`/`pwsh` results a pruned stub or skill marker describes,
 * and the `read` notices that stand for an earlier read.
 * @param logPointer - how a stub names its full result's journal event; omitted, the generic session-log pointer.
 * @returns fresh objects: plugin config resolution writes to the configuration it is given.
 */
export function prunedToolResultFormats(logPointer?: ToolResultFormats['logPointer']): ToolResultFormats {
  return {
    skillBodyName: skillContentName,
    retrievalNotice: splitSpillNotice,
    outcomeMarkers: { bash: exitMarkerOf, pwsh: exitMarkerOf },
    ...logPointer === undefined ? {} : { logPointer },
    pointedResults: unchangedReadPointers,
  }
}

/**
 * io-agent's pruner: the newest 5 tool groups stay verbatim; older results over
 * 2,048 characters become one-line stubs, and head/tail remains
 * only for an old result no stub can describe (its call is no longer
 * visible). Errors and media stay verbatim, and so does a read that a
 * re-read's "unchanged" notice within the newest 5 groups points at. A loaded skill body stays whole
 * while its skill was requested within 10 tool groups, then becomes the
 * skill-removed marker. It runs only under context pressure or
 * once the prompt cache is presumed cold.
 * @param logPointer - how a stub names its full result's journal event (see {@link prunedToolResultFormats}).
 * @returns a fresh configuration (plugin config resolution writes to it).
 */
export function toolResultPrunerConfig(logPointer?: ToolResultFormats['logPointer']): ToolResultPruneConfig {
  return {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
    retention: {
      keepRecentToolGroups: 5,
      stubAfterToolGroups: 5,
      stubMinChars: 2048,
      skillToolName: SKILL_TOOL_NAME,
      keepRecentSkillToolGroups: 10,
      preserveErrors: true,
      preserveMedia: true,
      minimumSavingsChars: 1024,
    },
    formats: prunedToolResultFormats(logPointer),
  }
}
