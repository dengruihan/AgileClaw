# Color Tokens

All tokens are defined in `ui/src/styles/base.css` under `:root` (dark mode default) and `:root[data-theme-mode="light"]` (light override). Phosphor is the single UI style; both blocks belong to it, and each carries its own WCAG audit comment.

> Contrast ratios use the WCAG relative luminance formula against `--bg` (`#0a0f0a` dark, `#f4f7f4` light). AA requires ≥4.5:1 for normal text, ≥3:1 for large text and UI components.

---

## Background Scale

| Token            | Dark Value | Light Value | Use                                  | Don't                          |
| ---------------- | ---------- | ----------- | ------------------------------------ | ------------------------------ |
| `--bg`           | `#0a0f0a`  | `#f4f7f4`   | Page root, deepest layer             | Never use on elevated surfaces |
| `--bg-accent`    | `#0e150e`  | `#ecf1ec`   | Sidebar, secondary panels            | Not for interactive card hover |
| `--bg-elevated`  | `#121a12`  | `#ffffff`   | Raised panels, modals                | Not for inline elements        |
| `--bg-hover`     | `#18221a`  | `#e4ebe5`   | List item hover state                | Not for default state          |
| `--bg-muted`     | `#18221a`  | `#e4ebe5`   | Subtle fills, disabled states        | Not for focus states           |
| `--shell-canvas` | `#070b07`  | `#e7eee8`   | Window canvas around the shell plate | Not for content surfaces       |

Light mode pairs deep green ink with cool paper: green-tinted backgrounds, sage borders (`#dbe4dc`), and a deep-green accent (`#10693a`, ≈6.3:1 on `--bg`). Dark mode keeps luminous phosphor green on green-cast black.

## Surface / Card

| Token                  | Dark Value               | Light Value           | Use                           | Don't           |
| ---------------------- | ------------------------ | --------------------- | ----------------------------- | --------------- |
| `--card`               | `#0e150e`                | `#ffffff`             | Card backgrounds, composer    | Avoid as border |
| `--card-foreground`    | `#e8f5e9`                | `#16201a`             | Text on cards                 | —               |
| `--card-highlight`     | `rgba(200,255,210,0.04)` | `rgba(20,50,30,0.02)` | Inner highlight on hover      | Not for text    |
| `--popover`            | `#121a12`                | `#ffffff`             | Dropdown, tooltip backgrounds | —               |
| `--popover-foreground` | `#e8f5e9`                | `#16201a`             | Text inside popovers          | —               |

## Text

| Token            | Dark Value | Contrast on dark `--bg` | Light Value | Use                                                |
| ---------------- | ---------- | ----------------------- | ----------- | -------------------------------------------------- |
| `--text`         | `#cfe0cf`  | ≈12:1 ✅                | `#2a352b`   | Body copy, labels                                  |
| `--text-strong`  | `#e8f5e9`  | ≈15:1 ✅                | `#16201a`   | Headings, emphasis                                 |
| `--muted`        | `#93ac95`  | ≈7:1 ✅                 | `#566b58`   | Placeholder, metadata                              |
| `--muted-strong` | `#a4bba6`  | ≈8:1 ✅                 | `#455947`   | Secondary text, captions; prefer `--text` for body |

## Accent (Primary — Phosphor Green)

| Token                  | Dark Value              | Light Value            | Use                                            |
| ---------------------- | ----------------------- | ---------------------- | ---------------------------------------------- |
| `--accent`             | `#4ade80`               | `#10693a`              | Primary CTA, send button, active tab indicator |
| `--accent-hover`       | `#6ee79b`               | `#0b512c`              | Hover state of accent elements                 |
| `--accent-muted`       | `#4ade80`               | `#10693a`              | Same as accent (aliased)                       |
| `--accent-subtle`      | `rgba(74,222,128,0.12)` | `rgba(16,105,58,0.1)`  | Badge backgrounds, tinted fills                |
| `--accent-glow`        | `rgba(74,222,128,0.22)` | `rgba(16,105,58,0.14)` | Focus rings, glow effects                      |
| `--primary`            | `#4ade80`               | `#10693a`              | Filled primary buttons                         |
| `--primary-hover`      | `#6ee79b`               | `#0b512c`              | Filled primary button hover                    |
| `--primary-foreground` | `#07120a`               | `#ffffff`              | Ink on filled primary buttons                  |

The style owns the accent palette. There is no user accent override: `ui.prefs.accent` and the appearance-page swatches were retired. `ui.seamColor` remains only for native app surfaces such as the macOS voice-wake glow and does not repaint Control UI tokens.

## Accent 2

| Token               | Dark Value               | Light Value            | Use                                       |
| ------------------- | ------------------------ | ---------------------- | ----------------------------------------- |
| `--accent-2`        | `#8fd6a5`                | `#2f6b47`              | Success-adjacent status, secondary badges |
| `--accent-2-muted`  | `rgba(143,214,165,0.7)`  | `rgba(47,107,71,0.75)` | Subtle fills                              |
| `--accent-2-subtle` | `rgba(143,214,165,0.12)` | `rgba(47,107,71,0.1)`  | Tinted background                         |

## Semantic

| Token           | Dark Value | Light Value | Contrast on dark `--bg` | Use                                            |
| --------------- | ---------- | ----------- | ----------------------- | ---------------------------------------------- |
| `--ok`          | `#22c55e`  | `#166534`   | ~8.4:1 ✅               | Success states, token meter low                |
| `--warn`        | `#f59e0b`  | `#92400e`   | ~8.9:1 ✅               | Warnings, degraded states                      |
| `--danger`      | `#f87171`  | `#b91c1c`   | ~6.9:1 ✅               | Errors, destructive text, token meter high     |
| `--info`        | `#60a5fa`  | `#1d4ed8`   | ~7.5:1 ✅               | Informational, token meter mid                 |
| `--destructive` | `#d32f2f`  | `#dc2626`   | ~3.8:1 (fill only)      | Destructive button fills (with `#fafafa` text) |

Each `--x` has `-muted` (0.75 alpha) and `-subtle` (0.08 alpha) rgba siblings that must stay in sync with the base hex — the base doubles as label text on its own subtle tint, and re-tinting one without the other silently drops the pair below AA. Bases stay literal hex because `widget-theme.ts` publishes them to MCP app guest documents where `color-mix()` would not resolve. See the audit comments in `base.css` for the measurements.

## Border

| Token             | Dark Value | Light Value | Use                              |
| ----------------- | ---------- | ----------- | -------------------------------- |
| `--border`        | `#1d291f`  | `#dbe4dc`   | Default subtle borders, dividers |
| `--border-strong` | `#2c3d2f`  | `#bfcdc1`   | Active/focused borders           |
| `--border-hover`  | `#3e5442`  | `#9aad9d`   | Hover-state borders              |

## Focus

| Token          | Dark Value                                                                        | Light Value                                                                       | Use                            |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| `--ring`       | `#4ade80`                                                                         | `#10693a`                                                                         | Focus ring colour              |
| `--focus-ring` | `0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 75%, transparent)` | `0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 70%, transparent)` | Standard focus ring box-shadow |
| `--focus-glow` | `0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)`         | `0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 12px var(--accent-glow)`         | Elevated interactive elements  |

## Neumorphic Surfaces

Phosphor's depth comes from one light direction: a light stroke from the top-left and a dark stroke to the bottom-right. `--neu-light` and `--neu-dark` are the only hue inputs; every shadow token composes them.

| Token                     | Use                                                                         |
| ------------------------- | --------------------------------------------------------------------------- |
| `--shadow-sm` … `-xl`     | Neutral elevation for cards, popovers, and dialogs                          |
| `--surface-raised`        | Resting extrusion on legacy surfaces (migrating to `--raise-shadow`)        |
| `--surface-raised-strong` | Higher-emphasis raised controls (legacy pairing)                            |
| `--surface-pressed`       | `:active` and toggled-in controls pushed into the surface (legacy pairing)  |
| `--surface-well`          | Recessed field for inputs and segmented-control containers (legacy pairing) |

Shared controls compose the newer physical-material tokens instead — `--raise-shadow`, `--press-shadow`, `--well-shadow`, and their `--mat-*` inputs (see [materials.md](./materials.md)) — which add a solid rim of thickness, a movable gloss, and press travel on top of the same light direction.

Dark uses `--neu-light: rgba(170,235,185,0.05)` and `--neu-dark: rgba(0,6,2,0.55)`; light uses `rgba(255,255,255,0.9)` and `rgba(29,56,38,0.16)`. Keep the light direction and token composition; do not hand-write per-component shadow pairs.

---

## Anti-Patterns

- ❌ Hardcoded hex colours in component CSS — always use tokens
- ❌ `--accent-subtle` as text colour — fails contrast on dark backgrounds
- ❌ Mixing `--ok` and `--accent-2` for "green success" — use `--ok` only
- ❌ Using `--danger` for non-error states (e.g. "hot feature") — reserve for errors and destructive actions
- ❌ `--muted-strong` for normal body text — passes AA on `--bg` but not on every hover/input surface; use `--text` instead
- ❌ Per-component shadow pairs — compose the `--mat-*`/`--raise-*`/`--press-*`/`--well-*` tokens (or the legacy `--surface-*` pairs) so one light direction holds app-wide
