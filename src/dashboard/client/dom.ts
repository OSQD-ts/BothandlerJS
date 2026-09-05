/**
 * The page's only way of putting something in the document.
 *
 * `textContent`, always. Every string that reaches this file — a User-Agent, a path, a
 * detector's summary, a rule id somebody typed into the editor — was written by
 * somebody else, and one `innerHTML` anywhere below turns a bot's User-Agent into
 * script running in an operator's browser. A test asserts the served page contains
 * none of the four ways to do that, and `scripts/build-client.mjs` refuses to bundle
 * one.
 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, value?: string | number | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== null && className !== "") node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}

export function svgEl(name: string, attributes: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

export function svgText(attributes: Record<string, string | number>, text: string | number): SVGElement {
  const node = svgEl("text", attributes);
  node.textContent = String(text);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Ids are base64url today, which needs no escaping — but a selector assembled from a
 * value is only safe until somebody widens the alphabet, and `CSS.escape` costs
 * nothing. The fallback covers the one browser generation that lacks it.
 */
export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&");
}

export function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  // Every id this is called with is one the page's own markup declares, so a miss is a
  // typo in a rename rather than a condition to handle. Failing loudly here beats a
  // null dereference three frames later.
  if (node === null) throw new Error(`dashboard: no element #${id}`);
  return node;
}

export function byId<T extends HTMLElement>(id: string): T {
  return $(id) as T;
}

/** A CSS custom property's value, for the charts — which draw in the theme's own colours. */
export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let sequence = 0;

/**
 * Ties a `<label>` to the control it names.
 *
 * A label sitting next to an input is a label to a reader who can see the layout and
 * nothing at all to a screen reader: it announces "edit, blank" and moves on. Both form
 * builders on this page had that defect, and both were caught by the automated
 * accessibility pass rather than by anybody looking — which is the argument for having
 * one.
 *
 * Only for the controls a label can point at. A group of chips or a segmented control is
 * several buttons, and those carry their own names.
 */
export function label(text: string, control: HTMLElement | HTMLElement[]): HTMLLabelElement {
  const node = document.createElement("label");
  node.textContent = text;
  const single = Array.isArray(control) ? (control.length === 1 ? control[0] : undefined) : control;
  if (single !== undefined && /^(input|select|textarea)$/i.test(single.tagName)) {
    if (single.id === "") single.id = `field-${++sequence}`;
    node.htmlFor = single.id;
  } else {
    // Nothing to point at, so the group gets the name instead and the text becomes
    // decoration rather than a promise the page does not keep.
    const group = Array.isArray(control) ? control : [control];
    for (const node_ of group) if (!node_.hasAttribute("aria-label")) node_.setAttribute("aria-label", text);
  }
  return node;
}
