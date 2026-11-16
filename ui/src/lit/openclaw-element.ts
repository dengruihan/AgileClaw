import { LitElement, css } from "lit";
import { I18nController } from "../i18n/lib/lit-controller.ts";

/** Continuous corner curvature for shadow trees.
 *
 * The light-DOM rule in `styles/base.css` cannot cross a shadow boundary, so
 * every OpenClaw shadow root adopts the same declaration here instead of
 * repeating it per component. `--corner-shape` is an inherited custom property,
 * so a host or an internal surface still opts out (or into a different shape)
 * exactly like a light-DOM rule does. Component styles are adopted after this
 * sheet, so a component's own shape declaration keeps winning.
 */
const continuousCornerStyles = css`
  *,
  *::before,
  *::after {
    corner-shape: var(--corner-shape, superellipse(1.5));
  }
`;

let continuousCornerSheet: CSSStyleSheet | undefined;

function adoptContinuousCornerStyles(root: ShadowRoot) {
  const canAdopt =
    "adoptedStyleSheets" in root &&
    typeof CSSStyleSheet === "function" &&
    "replaceSync" in CSSStyleSheet.prototype;
  if (canAdopt) {
    continuousCornerSheet ??= new CSSStyleSheet();
    if (continuousCornerSheet.cssRules.length === 0) {
      continuousCornerSheet.replaceSync(continuousCornerStyles.cssText);
    }
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, continuousCornerSheet];
    return;
  }
  const style = document.createElement("style");
  style.textContent = continuousCornerStyles.cssText;
  root.append(style);
}

/** Lit base that refreshes the element when the active locale changes. */
export abstract class OpenClawLitElement extends LitElement {
  protected readonly i18nController = new I18nController(this);

  override createRenderRoot() {
    const root = super.createRenderRoot();
    if (root instanceof ShadowRoot) {
      adoptContinuousCornerStyles(root);
    }
    return root;
  }
}

/** OpenClaw Lit base for components styled by the shared light-DOM stylesheet. */
export abstract class OpenClawLightDomElement extends OpenClawLitElement {
  override createRenderRoot() {
    return this;
  }
}

/** Light-DOM element whose host should not add a layout box around its render output. */
export abstract class OpenClawLightDomContentsElement extends OpenClawLightDomElement {
  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }
}
