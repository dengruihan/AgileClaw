import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import {
  MARKDOWN_CHAT_MATH_TAG,
  renderMarkdownMathInto,
  type MarkdownMathRenderResult,
} from "../../../components/markdown-math.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

type RenderState = "pending" | MarkdownMathRenderResult;

/**
 * One lazily typeset equation inside a rendered transcript.
 *
 * The parser placeholder keeps its delimited TeX as text, so the equation stays
 * readable until KaTeX loads (or permanently, when loading or the input budget
 * fails). Typeset markup replaces that text in the same light-DOM flow, which
 * keeps native selection and copy working across the message.
 */
class OpenClawChatMath extends OpenClawLightDomElement {
  @property({ attribute: false }) source = "";
  @property({ attribute: false, type: Boolean }) display = false;
  @state() private renderState: RenderState = "pending";
  private body: HTMLElement | null = null;
  private generation = 0;
  private started = false;

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add("openclaw-chat-math");
    if (!this.source) {
      // A table-expand clone copies rendered markup and attributes, not live
      // properties; adopt the cloned presentation instead of re-typesetting.
      this.display = this.classList.contains("openclaw-chat-math--display");
      this.started = true;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
  }

  protected override updated(changed: PropertyValues<this>) {
    this.classList.toggle("openclaw-chat-math--display", this.display);
    const sourceChanged = changed.has("source") || changed.has("display");
    if (sourceChanged) {
      this.started = false;
      this.renderState = "pending";
    }
    if (!this.started || sourceChanged) {
      void this.typeset();
    }
    if (this.source && this.getAttribute("data-math-state") !== this.renderState) {
      this.setAttribute("data-math-state", this.renderState);
    }
  }

  private async typeset() {
    this.started = true;
    const body = this.body;
    // Cloned markup owns its box; there is no source to typeset over it.
    if (!body || !this.source.trim()) {
      return;
    }
    const generation = ++this.generation;
    // A new source owns the box immediately; stale markup must not stand in.
    body.replaceChildren();
    const result = await renderMarkdownMathInto(body, this.source, this.display);
    if (generation !== this.generation) {
      return;
    }
    if (result !== "rendered") {
      body.replaceChildren();
    }
    this.renderState = result;
  }

  override render() {
    if (!this.source) {
      // Cloned table markup already owns these children.
      return nothing;
    }
    return html`<span
        class="openclaw-chat-math__body"
        ${ref((element) => {
          this.body = element instanceof HTMLElement ? element : null;
        })}
      ></span
      >${
        this.renderState === "rendered"
          ? nothing
          : html`<span class="openclaw-chat-math__source">${this.source}</span>`
      }`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-math": OpenClawChatMath;
  }
}

if (!customElements.get(MARKDOWN_CHAT_MATH_TAG)) {
  customElements.define(MARKDOWN_CHAT_MATH_TAG, OpenClawChatMath);
}
