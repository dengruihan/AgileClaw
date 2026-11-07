# M90 r1 review fixes — verification artifact

## P1: retired reply-theme authority removed

- `src/auto-reply/reply/reply-tool-authority.ts`: removed `resolveReplyThemeProfileId`, its fingerprint field, and the theme branch.
- `src/auto-reply/reply/queue/delivery-context.ts`: removed the theme profile field from the delivery-context key.
- `src/auto-reply/reply/reply-tool-authority.test.ts`: removed the theme-authority steering block; the independent-grant case now uses `screen`.
- `src/auto-reply/reply/queue.authority.test.ts`: collection grouping is now screen-only; policy deny groups every turn.
- Tests: `node scripts/run-vitest.mjs run src/auto-reply/reply/reply-tool-authority.test.ts src/auto-reply/reply/queue.authority.test.ts` → passed.

## P1: interactive retained gallery

`gallery/index.html` now ships the same runtime as the live gallery:

- Dark/Light toggle sets `data-theme`/`data-theme-mode` and persists the mode.
- Every `[data-feedback-for]` input persists to `localStorage` and reloads.
- `#gallery-copy` exports Markdown to `#gallery-export-output` and writes it to the clipboard.
- html/body are released from the app shell's viewport lock so all 8 sections render in one page.
- `.gallery .btn.primary.is-pressed` keeps the primary fill/ink with the pressed inset shadow (matches production cascade).

Verified over a local HTTP origin (Playwright): 8 sections, mode persisted, feedback survived reload, export text contained `- segmented: well reads clearly`, primary pressed computed background/color equals the resting primary (`rgb(74, 222, 128)` / `rgb(7, 18, 10)`), and no page errors.

Screenshots: `gallery-shots/gallery-dark.png`, `gallery-shots/gallery-light.png` (full page, all 8 sections).

## P1: chat before/after captures

`capture-pages.cjs` now opens `/chat/main`, asserts a real `.chat-thread .chat-group`, and rejects non-`/chat/` routes. Before captures were taken from the pre-M90 main checkout mock server (27d4d16d6); after captures from this worktree. All four pairs inspected: each shows the Molty transcript, composer, and mode-specific styling; none is `/new` or empty.

Hashes (`before/chat-*` differ from `before/home-*`; same for `after/`):

- before desktop light `150da99e…`, desktop dark `498cc240…`, narrow light `9ac243b3…`, narrow dark `224b6818…`
- after desktop light `32555592…`, desktop dark `31993258…`, narrow light `f88a8ad8…`, narrow dark `8776e28a…`

## P2: generated inventory residue

- `pnpm ui:boot-manifest:gen` regenerated `ui/config/control-ui-boot-modules.json`; 1609 first-party entries, 0 missing files (`r1-manifest-check.json`).
- Removed `themes/${string}.css` from `ui/src/app/public-assets.ts` and its deleted test fixture `themes/absolutely.css`.
- Removed the deleted `plugin-theme-art-http.test.ts` entry from `config/test-mock-exports-baseline.txt`.
- Rebuilt with `pnpm ui:build`; `pnpm tsgo:core` passed.
