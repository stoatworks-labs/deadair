# CLAUDE.md — Dead Air

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 49 tests
npm run build        # tsc -b && vite build -> dist/
npm run preview      # serve the built dist/ (does NOT apply _headers)
npx tsc -b           # typecheck only
```

## Deploy

`.github/workflows/deploy.yml` deploys every push to `main`. It needs
`CLOUDFLARE_API_TOKEN` (repo secret) and `CLOUDFLARE_ACCOUNT_ID` (repo variable). Do the
first-ever deploy by hand with `cf-run npm run deploy` — a new custom domain resolves slower
than the workflow's live check waits.

## Test media

`test-media/` is gitignored. Regenerate with macOS `say` and ffmpeg: four spoken sentences
separated by 1.5 s, 3.2 s, 0.4 s and 2.5 s of silence/room tone, muxed over `testsrc2` at
25 fps with `-timecode 01:00:00:00` (and a 29.97 `-timecode "10:00:00;00"` variant). Copy into
`public/test/` to drive the app from the Browser pane with a fetched `File` on the input.
