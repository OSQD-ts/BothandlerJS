/**
 * The shape of the Reference screen's text, and nothing that renders it.
 *
 * A structure rather than HTML. The write-ups are markdown in `docs/`, and the obvious
 * way to show markdown in a page is to turn it into markup and hand that to the document
 * — which is the one thing this client is built never to do. So the build reads the
 * markdown into these few block and inline kinds, and the page puts every word of it in
 * with `textContent`. A link in the source becomes its text: the pages it points at are
 * files in a repository, not something this dashboard can open.
 *
 * DOM-free, so the generated data can be checked under `npm test`.
 */

/** A run of text and how it is set. Nested emphasis is flattened to its innermost kind. */
export type Inline = [kind: "t" | "b" | "i" | "code", text: string];

export type Block =
  | { kind: "p"; text: Inline[] }
  | { kind: "h"; text: Inline[] }
  | { kind: "list"; items: Inline[][] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

export type ReferenceKind = "detector" | "action";

export interface ReferenceEntry {
  kind: ReferenceKind;
  id: string;
  /** The heading it sits under in the documentation, which is also how the index groups it. */
  group: string;
  /** The one-line facts: cost, stage and ceiling for a detector; terminal and cost to a person for an action. */
  facts: string[];
  /** The first paragraph as plain text, for the index's filter and tooltip. */
  summary: string;
  blocks: Block[];
  /** Where the full write-up lives, relative to the package. */
  source: string;
}

export interface ReferenceData {
  /** What each kind's entries have in common, shown before anything is picked. */
  intro: Record<ReferenceKind, Block[]>;
  entries: ReferenceEntry[];
}

/** The key an entry is selected and linked by: `detector:cadence`, `action:block`. */
export function referenceKey(kind: ReferenceKind, id: string): string {
  return `${kind}:${id}`;
}

/** The text of a run of inlines, with the setting dropped. */
export function plainText(inlines: readonly Inline[]): string {
  return inlines.map(([, text]) => text).join("");
}
