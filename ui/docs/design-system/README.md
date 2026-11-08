# OpenClaw Design System

OpenClaw's visual language is **Phosphor**: luminous green ink on a green-cast black canvas (or deep green on cool paper in light mode), and a **physical material system** for every control. Light arrives from above: interactive surfaces are raised keys with a graded face, a specular top edge, and a solid rim of thickness; pressing pushes them into the plate, and fields sit in recessed grooves. The shell floats as one rounded base plate on the darker window canvas. Motion is crisp and purposeful — fast micro-interactions with spring-loaded press release. All interactive elements meet WCAG 2.1 AA contrast requirements in both theme modes.

## Contents

| File                                       | What it covers                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| [materials.md](./materials.md)             | Physical control material: tokens, light model, press physics, reduced motion           |
| [glass-surfaces.md](./glass-surfaces.md)   | Two glass tiers, exact CSS values, no-solid-panels rule, `@supports` fallback           |
| [color-tokens.md](./color-tokens.md)       | All design tokens with values, usage, contrast ratios, and anti-patterns                |
| [motion.md](./motion.md)                   | Duration scale, easing functions, `prefers-reduced-motion` pattern, animation inventory |
| [accessibility.md](./accessibility.md)     | WCAG checklist: contrast, focus, tap targets, ARIA, skip link, focus trap               |
| [settings-design.md](./settings-design.md) | Settings page anatomy: sections, groups, rows, controls, status dots, migration rules   |

## Guiding Principles

1. **One light source, one material** — Every raised face, groove, and rim composes the shared `--mat-*` tokens (see [materials.md](./materials.md)); no control rolls its own bevel, so light reads consistently across themes.
2. **Depth through layering** — The background scale (`--bg`, `--bg-accent`, `--bg-elevated`, `--bg-hover`, `--bg-muted`) communicates hierarchy; controls add real thickness (rim), recess (groove), and travel (press) instead of flat fills with blur.
3. **Accent with restraint** — Phosphor green (`--accent`) for primary actions and latched states only; `--accent-2` for secondary/status.
4. **Motion serves meaning** — Animations telegraph state changes; the press lands with the finger and the release springs back. They never play for decoration alone.
5. **Accessible by default** — Every component ships with focus-visible styles, correct ARIA roles, and ≥4.5:1 contrast on text in dark and light modes.
