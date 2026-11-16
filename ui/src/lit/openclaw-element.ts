import { LitElement } from "lit";
import { I18nController } from "../i18n/lib/lit-controller.ts";
import continuousCornerCss from "../styles/continuous-corners.css?inline";

/** Continuous corner curvature for shadow trees.
 *
 * `styles/continuous-corners.css` is the single shape source: the document
 * loads it through `styles.css`, and every OpenClaw shadow root adopts the same
 * text here. That covers Lit component internals and the Web Awesome parts one
 * shadow root inside that tree, which a document `::part()` rule can never
 * reach. The sheet is adopted before component styles so a component's own
 * shape declaration still wins.
 */
let continuousCornerSheet: CSSStyleSheet | undefined;

function adoptContinuousCornerStyles(root: ShadowRoot) {
  const canAdopt =
    "adoptedStyleSheets" in root &&
    typeof CSSStyleSheet === "function" &&
    "replaceSync" in CSSStyleSheet.prototype;
  if (canAdopt) {
    continuousCornerSheet ??= new CSSStyleSheet();
    if (continuousCornerSheet.cssRules.length === 0) {
      continuousCornerSheet.replaceSync(continuousCornerCss);
    }
    root.adoptedStyleSheets = [continuousCornerSheet, ...root.adoptedStyleSheets];
    return;
  }
  const style = document.createElement("style");
  style.textContent = continuousCornerCss;
  root.prepend(style);
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
