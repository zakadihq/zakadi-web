// DOM construction for <zakadi-call> (spec/06-web-sdk.md 6.4.1): createElement,
// createElementNS and textContent only, never an HTML string, so that nothing here needs
// a Trusted Types policy. Called only from inside the element, never at module scope.

type Attrs = Record<string, string>;

/** An HTML element with its class, attributes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  attrs: Attrs = {},
  ...kids: Node[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** An SVG element with its attributes and children. */
export function svg(tag: string, attrs: Attrs = {}, ...kids: Node[]) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** Sets the text of `e` when it differs. */
export function text(e: Node, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

/** Shows or hides `e` through its `hidden` attribute. */
export function show(e: Element, on: boolean): void {
  e.toggleAttribute("hidden", !on);
}
