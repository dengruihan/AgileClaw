# Physical Control Material

OpenClaw's shared controls are physical: every interactive surface is a piece
of material lit from above, and interacting with it moves that material. One
generation of tokens in `ui/src/styles/base.css` drives the whole vocabulary —
no control rolls its own bevel, so light reads consistently across the app,
both theme modes, and every user theme.

## Light model

Light arrives from above. Three depths cover every shared control:

- **Raised** — the resting key, chip, or card: a graded dome face, a specular
  edge along its top, a solid rim of thickness underneath, and a soft contact
  shadow where it meets the plate.
- **Pressed** — the same face pushed in: the rim collapses, an inset shadow
  takes its place (the thumb shades the top of the well), and the whole
  control travels `--press-shift` down. Toggled-in controls stay latched in
  this seat.
- **Well** — a recessed groove for fields: the floor sits darker where the
  top wall occludes the light and catches a faint bevel on the inner bottom
  lip. Text inputs, selects, segmented tracks, and the range groove are wells.

## Tokens

Defined in `:root` (dark) and `:root[data-theme-mode="light"]` in
`ui/src/styles/base.css`:

| Token                  | Role                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `--mat-bevel`          | Specular catch on a raised face's top edge                    |
| `--mat-face-hi/lo`     | Face gradient stops (dome light and shade)                    |
| `--mat-rim`            | Solid thickness under a raised face                           |
| `--mat-rim-hi`         | Light caught inside a pressed seat's lower lip                |
| `--mat-gloss`          | Specular wash that travels down the face while pressed        |
| `--raise-face`         | Composed raised-face gradient                                 |
| `--raise-shadow`       | Resting key shadow stack (bevel + rim + contact)              |
| `--raise-shadow-hover` | Slightly taller rim and contact while hovered                 |
| `--key-shadow`         | Sidebar rail key stack: same inputs, 1px rim, whisper contact |
| `--key-shadow-hover`   | Hovered rail key: rim thickens, contact deepens               |
| `--press-shadow`       | Pushed-in shadow stack (inset shade + shrunken rim)           |
| `--well-face`          | Groove floor gradient (darker under the top wall)             |
| `--well-shadow`        | Groove depth (top inner shade + bottom lip catch)             |
| `--press-shift`        | Whole-control travel on `:active` (1px)                       |
| `--duration-press`     | Press lands with the finger (40ms)                            |
| `--duration-release`   | Release settles on `--ease-spring` (260ms)                    |

The older `--surface-*` pairs remain for surfaces that have not migrated;
new work composes the `--mat-*` vocabulary above.

## Press physics

```css
transition:
  /* …color properties… */
  background-position var(--duration-release) var(--ease-spring),
  box-shadow var(--duration-release) var(--ease-spring),
  transform var(--duration-release) var(--ease-spring);

&:active {
  transform: translateY(var(--press-shift));
  box-shadow: var(--press-shadow);
  /* The press lands immediately; only the release springs. */
  transition-duration: var(--duration-press);
}
```

The gloss layer is a 200%-tall gradient whose `background-position` animates:
light hits the top of the key at rest and its lower lip while pressed.
Because the release transition runs on `--ease-spring`
(`cubic-bezier(0.34, 1.56, 0.64, 1)`), letting go overshoots slightly past
resting — the elastic settle. Under `prefers-reduced-motion: reduce` the
global reset in `base.css` drops every transition to zero while the state
changes (travel, inset shadow, gloss) still swap instantly; Web Awesome's
shadow-DOM switch cap carries its own local guard for the same reason.

## Owners

- Buttons (`.btn` family), field inputs (`.field input/textarea/select`),
  check/radio latches, and the `.field`
  range fader live in `ui/src/styles/components.css`. The checked checkbox's
  check is real geometry: a short falling 45° arm and a long rising 135° arm,
  each a px-weighted stroke band clipped to its own tile, meeting at a low
  left-of-center vertex. The rendered glyph is proven pixel-wise in
  `ui/src/e2e/skeuomorphic-controls.e2e.test.ts` (single low vertex, single
  high tip, connected stroke), which rejects both an X and a chevron.
- Settings vocabulary (`.settings-input`, `.settings-select`,
  `.settings-segmented`) lives in `ui/src/styles/settings-controls.css` and
  composes the same tokens.
- The Web Awesome switch (`wa-switch`) is a lever in a machined channel:
  document CSS reaches its shadow DOM through `::part(control)` (channel well)
  and `::part(thumb)` (proud cap, spring throw via
  `--wa-transition-easing: var(--ease-spring)`). The library implements click
  and arrow-key throws only; positional thumb dragging is not part of its
  contract.
- Hub route tabs (`wa-tab.hub-tab` in `ui/src/styles/hub-tabs.css`) share the
  nav-row contract through `::part(base)`: quiet rest, hover fill, pressed
  well with travel, and the active route as a raised chip. ARIA tablists are
  keyboard-entered at the active tab; arrow keys move within.
- Option-card choice keys and their card container
  (`ui/src/styles/option-card.css`) and the usage preset groove
  (`ui/src/styles/usage.css`) compose the same material; carapace surfaces
  keep their own tone but restyle real `.btn.oc-action` keys with
  `background-color` so the shared face layers survive underneath. The same
  owner split covers physics: every carapace variant tone rule (primary,
  secondary, light, ghost) sets `background-color` only, and the generic
  carapace press/ease (`scale(0.98)` squeeze, fast ease-out) is scoped to
  `:not(.btn)` so shared keys keep the shared travel and spring release while
  carapace's own non-`.btn` keys keep theirs (`ui/src/styles/carapace-control-ui.css`).
- Navigation rows, the settings rail, shell chrome keys, the new-session
  action, and the shell plate's rimmed slab live in `ui/src/styles/layout.css`.
  The session-list paper feed (the recessed well, its passive outlet, the
  continuous strip, records, state/wash rules, and the list's inline inset) is
  owned by the lazy sidebar component's `ui/src/styles/app-sidebar.css`, which
  loads after the global bundle; the roster sheet keeps its later reset
  precedence. Pinned Session records join the same feed in canonical zone
  order; non-Session Pages entries stay console keys.
- Two shared rules own the repeated rail-key chrome in `ui/src/styles/layout.css`
  so per-control rules carry only geometry and states: a grouped seated-key
  material rule (`.sidebar-brand__icon`, `.nav-item`, `.sidebar-identity-card`)
  applies the shared contour, graded face, and rim, and a grouped hover rule
  (same keys plus the Inbox button) applies the shared hover seat; the build's
  hover guard media-wraps that rule, and the brand's `:focus-visible` rule
  restates the hover seat outside it so keyboard focus keeps the seat on
  non-hover devices. The collapsed-expand toggle and the personal-theme Inbox
  hooks (`--sidebar-issues-border`/`--sidebar-issues-background` still gate
  the Inbox fallbacks) keep their own inline copies. The roster reset uses
  `background: none`, which clears both the face retint and the gradient in
  one declaration.
- The sidebar reads as a console rail of seated keys with one deliberate
  exception. Nav rows, the collapse and collapsed expand toggles, the footer
  identity card, the Inbox button, and the session list's inline action and
  disclosure keys seat their interaction in their own boxes. Pinned Session
  records are list records on the paper feed, not console keys; the Pages
  entries above the feed keep the rail's key construction.
- The session list itself is one continuous paper feed, not a column of
  cards. `ui/src/styles/app-sidebar.css` shapes `.sidebar-sessions` as a
  shallow cool-gray well pressed into the sidebar, with the same-material
  convex lip and narrow recessed slit of a paper outlet at its upper end; the
  slit carries only a faint roller hint, never a printer body, control, or
  label. One matte strip in the panel's own color family — a step brighter
  than the well, never beige paper — runs unbroken from that slit behind every
  group heading, catalog, and expanded child tree, inset by a narrow side
  clearance with a soft contact shadow. Records on the strip are a
  left-aligned title over a fine incised rule; the old per-row tab face, grip
  band, slot mouth, and travel are removed in this scope. Hover and focus
  lighten the record, the current session carries a restrained accent wash and
  stronger title, multi-select deepens the wash, and pin/archive/disclosure
  controls surface as their existing seated keys on interaction. The strip is painted behind
  the content (pseudo-elements on the well), so headings and gaps cannot
  detach it; empty, loading, error, catalog, and roster states share the same
  material. Pinned Session records stay in canonical pinned order at the top
  of the same strip and keep their pin/order/menu behavior; only non-Session
  Pages entries remain in the console rail.

Feature-owned sliders (chat audio seek, reasoning effort) and dashboards keep
their own chrome by class and never enter this vocabulary.
