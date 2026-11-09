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
  That sheet also fixes the session scroller's geometry: Online and the user
  footer keep their intrinsic height, while the session well takes the space
  between them. The outer sidebar never scrolls. The well's material, record
  states, and scroll-edge fades live in the lazy sidebar component's
  `ui/src/styles/app-sidebar.css`; the roster sheet keeps its later reset
  precedence. Pinned Session records join the same well in canonical zone
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
  disclosure keys seat their interaction in their own boxes. Session records
  stay flat within their shared well; only their inline action and disclosure
  keys rise on interaction.
- `.sidebar-sessions` is a shallow cool-gray well pressed into the sidebar.
  Its floor stays close to the sidebar tone; a faint inner shade on the top
  and left and a soft highlight on the bottom and right describe the recess
  without a heavy face gradient. Its size does not depend on the number of
  sessions: the decorative frame never scrolls, and only its nested list
  scrolls and carries the content-edge fades. Navigation and the user
  footer stay fixed. Expanded Online scrolls inside its own bounded section
  (header pinned, roster scrolling under it) instead of displacing the well;
  at very short window heights the whole Online section yields its space to
  the well and is hidden outright, the in-well session toolbar is removed
  with it (new-session stays in the brand; filter/sort return above the
  band), and in agent-roster mode the compact roster group header is removed
  with the band as well, leaving the session rows as the only controls in
  the well.
  No outlet, continuous paper strip,
  per-row rule, or separate backing panel is drawn. Pinned and unpinned
  records share the same scroller and keep their selection, ordering,
  pin/archive, child-tree, and menu behavior. Hover and focus lighten the
  record, the current session carries a restrained accent wash and stronger
  title, and multi-select deepens the wash. Empty, loading, error, catalog,
  and roster states use the same fixed well.

Feature-owned sliders (chat audio seek, reasoning effort) and dashboards keep
their own chrome by class and never enter this vocabulary.
