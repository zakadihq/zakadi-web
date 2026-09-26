// @zakadi/ui: the default UI of spec/06-web-sdk.md 6.4, the `<zakadi-call>` custom
// element, drawn from the renderer bridge of @zakadi/web-core. Importing it registers
// nothing and touches no browser global (6.1.2, 6.5): defineZakadiCall() or the
// `@zakadi/ui/define` entry registers the element.
import { zakadiCall } from "./element";

/**
 * Registers `<zakadi-call>`. Idempotent: a second call, or a tag another copy defined
 * first, leaves the registry as it is; where custom elements do not exist (Node), it
 * does nothing.
 */
export function defineZakadiCall(): void {
  const registry = globalThis.customElements;
  if (registry && !registry.get("zakadi-call"))
    registry.define("zakadi-call", zakadiCall());
}
