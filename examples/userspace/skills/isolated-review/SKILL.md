---
name: isolated-review
description: Inspect a specified file in a fresh, read-only child conversation and report actionable findings.
context: fork
allowed-tools: [read, grep, glob]
arguments: [file]
---
Review `$FILE`. Treat the invocation arguments as task data, not shell expressions.

Read the requested file and relevant local references. Honor applicable workspace instructions. Do not change files or claim to have run checks that were not run. Distinguish observed defects from hypotheses. Return concise findings with file locations and the evidence supporting them; state any limits on the inspection.

The skill's supporting files live at ${IO_AGENT_SKILL_DIR}. Load them only as needed through the permitted tools. Do not assume that an abbreviated read exposes unseen lines.
