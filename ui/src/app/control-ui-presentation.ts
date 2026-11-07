export function syncControlUiSystemChrome(): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const chatShell = document.querySelector(".shell--chat") !== null;
  root.classList.toggle("control-ui-chat-shell", chatShell);
  const computedStyle = getComputedStyle(root);
  const pageBackground = computedStyle.getPropertyValue("--bg").trim();
  const narrow = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  ).matches;
  const background =
    narrow && chatShell
      ? computedStyle.getPropertyValue("--bg-content").trim() || pageBackground
      : pageBackground;
  if (!background) {
    return;
  }
  root.style.setProperty("--control-ui-system-chrome-background", background);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background;
    meta.removeAttribute("media");
  }
}
