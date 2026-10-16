/** Pure first-party message interpreters for detached current-format replay, including browser readers. */

import { imageOffloadProjection } from "../../context/compaction/image-offload/projection.ts"
import type { SessionMessageProjection } from "../journal/surface.ts"

/** Installed interpretation definitions; recovery listeners are mounted separately by their owning plugins. */
export const currentSessionMessageProjections: readonly SessionMessageProjection[] = [imageOffloadProjection]
