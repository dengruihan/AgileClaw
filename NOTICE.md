# NOTICE

## ZCode desktop shell motion

Portions of the Control UI desktop shell motion are adapted from ZCode:

- Upstream: https://github.com/zai-org/ZCode
- Pinned commit: `fec975905a2abd4c07e35c40d51fa097a2258ec9`
- Upstream sources:
  - `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
  - `packages/ui/src/app-shell/useAnimatedResizablePanel.ts`
  - `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`
  - `docs/performance/sidebar-toggle-rendering.md`
- License: Apache License 2.0 (see the upstream `LICENSE`)
- Copyright: ZCode contributors

The port covers the left navigation and right dock open/close motion in
`ui/src/styles/layout.css`, `ui/src/components/dock-layout-controller.ts`, and
the dock panel renderers. Repo-wide third-party notices remain in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
