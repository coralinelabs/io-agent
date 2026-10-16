# Working on io-agent

- Agent policy lives in `src/loop.ts`, capability wiring in `src/plugins`, model-facing text in `src/prompts`, implementations in `src/library`. No second agent loop, journal or fallback harness.
- After editing a prompt, run `pnpm prompts:generate` and `pnpm prompts:check`.
- Add regression tests on the default runtime path, not only library tests. Never weaken an assertion to hide missing sandbox enforcement.
- Source zips come from `scripts/source_zip.py`: no dependencies, builds or logs.
