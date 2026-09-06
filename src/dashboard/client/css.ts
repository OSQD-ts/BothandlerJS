/**
 * Selector escaping, on its own so both halves can have it.
 *
 * `dom.ts` is the browser client's entry into the document and carries module state that
 * has to be initialised in order; the embeddable element imports it lazily for exactly
 * that reason. But the element also assembles selectors from developer-supplied panel ids
 * *synchronously*, before any of that has happened — so the escape lives here, in a leaf
 * with nothing behind it, rather than being duplicated or dragging the client graph in
 * early.
 */
export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&");
}
