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

| Token                  | Role                                                   |
| ---------------------- | ------------------------------------------------------ |
| `--mat-bevel`          | Specular catch on a raised face's top edge             |
| `--mat-face-hi/lo`     | Face gradient stops (dome light and shade)             |
| `--mat-rim`            | Solid thickness under a raised face                    |
| `--mat-rim-hi`         | Light caught inside a pressed seat's lower lip         |
| `--mat-gloss`          | Specular wash that travels down the face while pressed |
| `--raise-face`         | Composed raised-face gradient                          |
| `--raise-shadow`       | Resting key shadow stack (bevel + rim + contact)       |
| `--raise-shadow-hover` | Slightly taller rim and contact while hovered          |
| `--press-shadow`       | Pushed-in shadow stack (inset shade + shrunken rim)    |
| `--well-face`          | Groove floor gradient (darker under the top wall)      |
| `--well-shadow`        | Groove depth (top inner shade + bottom lip catch)      |
| `--press-shift`        | Whole-control travel on `:active` (1px)                |
| `--duration-press`     | Press lands with the finger (40ms)                     |
| `--duration-release`   | Release settles on `--ease-spring` (260ms)             |

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
  check/radio latches, and the `.field` range fader live in
  `ui/src/styles/components.css`.
- Settings vocabulary (`.settings-input`, `.settings-select`,
  `.settings-segmented`) lives in `ui/src/styles/settings-controls.css` and
  composes the same tokens.
- The Web Awesome switch (`wa-switch`) is a lever in a machined channel:
  document CSS reaches its shadow DOM through `::part(control)` (channel well)
  and `::part(thumb)` (proud cap, spring throw via
  `--wa-transition-easing: var(--ease-spring)`). The library implements click
  and arrow-key throws only; positional thumb dragging is not part of its
  contract.
- Navigation rows, the settings rail, shell chrome keys, the new-session
  action, and the shell plate's rimmed slab live in `ui/src/styles/layout.css`.

Feature-owned sliders (chat audio seek, reasoning effort) and dashboards keep
their own chrome by class and never enter this vocabulary.
