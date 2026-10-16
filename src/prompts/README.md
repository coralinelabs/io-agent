# Prompts

Every text the model reads is a file here, listed in `manifest.json` with its ID, parameters and hash. Code reads it through the generated `catalog.generated.ts`.

After editing a file:

```sh
pnpm prompts:generate
pnpm prompts:check
pnpm test:prompts
pnpm build
```

- Don't edit `catalog.generated.ts` by hand.
- A changed file records its new hash and a note in `manifest.json`.
- `{{snake_case}}` parameters are substituted once, literally.
- `prompts:check` fails on model-facing text written inline in `src/` and on files nothing uses. Allowed exceptions are in `scripts/prompts/structural-exceptions.json`.
