# M90 r2 Home capture repair

Issue: `capture-pages.cjs` only waited for `.shell` + 600 ms for `/new`, so some Home captures landed while the route was still restoring.

Fix in `.artifacts/m90-neumorphic/capture-pages.cjs`:

- Home now has a route-specific `homeReady` gate:
  - visible `Molty` heading from `.new-session-page__scroll h2` (not the hidden mount fallback);
  - visible `.new-session-page__message` composer and `disabled === false`;
  - `location.pathname === "/new"`.
- Only after those pass does the capture take a 200 ms paint settle. Chat keeps its `.chat-thread .chat-group` gate and `/chat/` assertion.

Diagnostic: on both mock servers `/new` renders the shell first, then the New Session page (~1.5 s). The new predicate waits for the actual route content and would fail rather than capture the restoring frame. No product defect: the blank frames were capture-readiness races, not a UI render failure.

Recaptured from pre-M90 main mock (4193) and exact-candidate worktree mock (4195), all four Home pairs inspected:

- `before/home--desktop--light.png` — sidebar, Molty heading, composer, What can you do suggestions
- `before/home--desktop--dark.png` — same content, dark Phosphor/claw baseline
- `before/home--narrow--light.png` — mobile header, Molty heading, composer
- `before/home--narrow--dark.png` — same content, dark baseline
- `after/home--desktop--light.png` — Phosphor light Home
- `after/home--desktop--dark.png` — Phosphor dark Home
- `after/home--narrow--light.png` — Phosphor light narrow Home
- `after/home--narrow--dark.png` — Phosphor dark narrow Home

SHA-256:

- before desktop dark `2e52374bf59544c7317aaf12adfd53dd2d7e301b64944d3a1a8c9951271fe9cf`
- before desktop light `47956cb02e2a257d10b4400cef00720e43e307299ff408e1427eb4c096fd742e`
- before narrow dark `0fa3e9d317ad964c63c2f3e3c332c5e2e787c8534fca8f07109e875d27966e68`
- before narrow light `f6aed65bd8c764c06f4204b09b5178a1914731498dd8283a060f76f204e995ed`
- after desktop dark `e4010eb15a5d2347e4c596e2365a586be2c78388f344f2b794666bb44c8bf581`
- after desktop light `bda5e2da29303c0d07aec1031ea1b4b0b234b85f949bd8b0900fa089a5c4c2c0`
- after narrow dark `6ee1d3e0ce826558cde8198b1e92e859af2ce09a62cfb5565f04af9d8fd220c8`
- after narrow light `5d9659e865629db5f6ec2ff454816bf5d43951a96d264fbff53a6b33e5b55642`

No product source changed in this round. The capture helper and these evidence notes are committed with this proof commit; screenshots remain untracked under `.artifacts/`.
