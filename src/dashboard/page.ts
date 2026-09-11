import { CLIENT_SCRIPT } from "./client.generated.js";
import type { DashboardSections } from "./types.js";

/**
 * The dashboard page.
 *
 * Shipped as a template rather than as a file on disk: a bundled library cannot assume
 * anything about what sits next to its own JavaScript, and a dashboard that works from
 * `src` and 404s from `dist` is the worst kind of bug to find. The markup and the CSS
 * are the template below; the behaviour is a real TypeScript module under `client/`,
 * bundled into {@link CLIENT_SCRIPT} at build time by `scripts/build-client.mjs` and
 * stamped in here. It used to be two thousand lines of JavaScript inside this string,
 * where the type-checker could not see it, Biome did not lint it and no test could
 * import a function out of it — which is how a call to a function nobody had written
 * shipped and blanked the whole Statistics tab.
 *
 * Three rules govern everything here, and all three are about the fact that this page
 * renders **attacker-supplied text**. A User-Agent is written by the client. So is the
 * path. So is anything a detector quoted into an evidence summary.
 *
 * 1. **Nothing is ever assembled into HTML.** Every value reaches the document through
 *    `textContent`. There is no `innerHTML` in the page or in the bundle, and the
 *    build refuses to produce one.
 * 2. **No `style` attributes.** The page is served under a nonce-based CSP, which
 *    blocks inline styles; geometry is set through the CSSOM (`el.style.width`), which
 *    is not a style attribute and is allowed.
 * 3. **No network access of any kind.** `default-src 'none'` and no external font,
 *    script or image. Everything is here.
 */

export interface DashboardPageOptions {
  title: string;
  basePath: string;
  links: ReadonlyArray<{ label: string; href: string }>;
  allowReset: boolean;
  allowEdit: boolean;
  allowGuardEdit: boolean;
  allowActing: boolean;
  peers: ReadonlyArray<{ label: string; href: string }>;
  /** Which parts of the page this listener has. The client removes the rest of them. */
  sections: Required<DashboardSections>;
}

/**
 * Builds the page once and returns a function that stamps a per-response nonce into
 * it. The HTML is a few tens of kilobytes and identical on every request; rebuilding
 * it per view would be pure waste.
 */
/**
 * What the page is told about itself.
 *
 * Built here rather than inline in the renderer so that the embeddable element can be
 * served the identical object from `/api/bootstrap`. The page carries it stamped into its
 * one nonced script; the element has to ask, because it is rendered into somebody else's
 * document and there is nothing to stamp.
 */
export function bootFor(options: DashboardPageOptions): Record<string, unknown> {
  return {
    base: options.basePath === "/" ? "" : options.basePath,
    title: options.title,
    allowReset: options.allowReset,
    allowEdit: options.allowEdit,
    allowGuardEdit: options.allowGuardEdit,
    allowActing: options.allowActing,
    peers: options.peers.map((peer) => ({ label: String(peer.label), href: String(peer.href) })),
    sections: options.sections,
    links: options.links.map((link) => ({ label: String(link.label), href: String(link.href) })),
  };
}

export function renderDashboardPage(options: DashboardPageOptions): (nonce: string) => string {
  const bootstrap = escapeForScript(JSON.stringify(JSON.stringify(bootFor(options))));

  // Function replacements throughout, never string ones. `String.prototype.replace`
  // reads `$&`, `` $` `` and `$'` out of a *string* replacement and substitutes match
  // context for them — so a title, a link label or a minified bundle containing one of
  // those sequences would otherwise rewrite itself on the way into the page.
  const html = PAGE.replace("__BOOT_JSON__", () => bootstrap)
    .replace("__SCRIPT__", () => CLIENT_SCRIPT)
    .replace(/__TITLE__/g, () => escapeHtml(options.title));
  return (nonce: string) => html.replace(/__NONCE__/g, () => nonce);
}

/**
 * Makes a JSON literal safe to sit inside a `<script>` element.
 *
 * `JSON.stringify` is not enough, and the gap is not theoretical: HTML ends a script
 * element at the first `</script>` in the source, *including one inside a string
 * literal*. A caller passing that sequence as a dashboard `title` — or a link label —
 * would otherwise close the tag and open one of their own. Escaping the angle brackets
 * as `\u003c` / `\u003e` keeps the value identical after `JSON.parse` while making the
 * sequence unrecognisable to the HTML parser. The two line separators are the same
 * class of problem for older parsers.
 */
function escapeForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/**
 * The dashboard's stylesheet, on its own.
 *
 * Separated from the document so the same rules can be adopted into a shadow root by the
 * embeddable element. The selectors are written `:root, :host` throughout for that
 * reason: `:root` matches the document element on the standalone page and matches nothing
 * inside a shadow tree, where `:host` is the element the tokens have to hang off.
 */
export const DASHBOARD_CSS = String.raw`/* ---------------------------------------------------------------------------
   Tokens.

   The two series colours and the critical status step are the validated data
   palette: blue and orange clear every colour-vision gate against both surfaces as
   an adjacent pair, and every chart that uses them also carries a legend and a
   label, so hue is never the only thing distinguishing anything. Text never wears a
   series colour — the ink tokens below are all at least 4.5:1 on their surface.
--------------------------------------------------------------------------- */
:root, :host {
  color-scheme: light;
  --page: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #fafafa;
  --raised: #ffffff;
  --line: #e4e6ea;
  --line-soft: #eef0f3;
  --ink: #0b0d12;
  --ink-2: #3c414b;
  --muted: #5f646e;
  --s1: #2a78d6;
  --s2: #eb6834;
  --crit: #d03b3b;
  /* The series blue carries white text at about 3.9:1, which is under the 4.5 floor —
     fine for a bar, not for a label. Solid buttons get a darker blue of their own
     rather than a lighter series colour, because the series colour is validated for
     charts and moving it would move every chart with it. */
  --accent-solid: #1b5fb0;
  --good-text: #006300;
  /* Darker than it looks like it needs to be, and measured rather than judged. This ink
     appears on a 16%-amber chip, and that chip can sit on the open row's blue tint —
     three layers, each lightening the background under the same text. At #8a5a00 the
     suspected badge measured 3.52:1 there, under the 4.5 floor for 11px bold. */
  --warn-text: #6d4700;
  --crit-text: #b02525;
  --info-text: #1c5cab;
  --proven-text: #5b34a8;
  --grid: #eceef1;
  --shadow: 0 1px 2px rgba(11,13,18,.06), 0 1px 8px rgba(11,13,18,.04);
  --focus: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]), :host(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0f12;
    --surface: #16181d;
    --surface-2: #1b1e24;
    --raised: #1f232a;
    --line: #272b33;
    --line-soft: #202329;
    --ink: #f2f4f7;
    --ink-2: #c4cad3;
    --muted: #8b929c;
    --s1: #3987e5;
    --s2: #d95926;
    --crit: #d03b3b;
    --accent-solid: #2364b4;
    --good-text: #4ec97a;
    --warn-text: #fab219;
    --crit-text: #ff8078;
    --info-text: #86b6ef;
    --proven-text: #b3a4f5;
    --grid: #23272e;
    --shadow: none;
    --focus: #86b6ef;
  }
}
:root[data-theme="dark"], :host([data-theme="dark"]) {
  color-scheme: dark;
  --page: #0d0f12;
  --surface: #16181d;
  --surface-2: #1b1e24;
  --raised: #1f232a;
  --line: #272b33;
  --line-soft: #202329;
  --ink: #f2f4f7;
  --ink-2: #c4cad3;
  --muted: #8b929c;
  --s1: #3987e5;
  --s2: #d95926;
  --crit: #d03b3b;
  --accent-solid: #2364b4;
  --good-text: #4ec97a;
  --warn-text: #fab219;
  --crit-text: #ff8078;
  --info-text: #86b6ef;
  --proven-text: #b3a4f5;
  --grid: #23272e;
  --shadow: none;
  --focus: #86b6ef;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
/* Restored by the client once the first render has settled. See the note on .tiles. */
html.settling { overflow-anchor: none; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tnum { font-variant-numeric: tabular-nums; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 6px; }

/* --- header -------------------------------------------------------------
   Two rows, and the split is the whole idea.

   The first carries identity, connection state and the controls — everything you
   can *press*. The second carries the tab strip and, at the far end, the handful of
   configuration facts that used to sit up top wearing the same bordered pill as the
   buttons beside them. Ten identical rounded rectangles in a row, five of which did
   nothing when clicked, is not a toolbar; it is a guessing game. The facts are now
   plain text — the one treatment nothing else on the page uses for a control — and
   they fill the tab strip's empty right-hand side rather than needing room of their
   own.

   Nothing here has a fixed height. The old row was pinned to 54px with children that
   refused to shrink, so on a narrow window the title and the live indicator drew on
   top of each other rather than wrapping.
------------------------------------------------------------------------- */
header {
  position: sticky; top: 0; z-index: 20;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: saturate(180%) blur(8px);
  border-bottom: 1px solid var(--line);
  padding: 0 20px;
}
.head-row { display: flex; align-items: center; gap: 10px 14px; min-height: 54px; flex-wrap: wrap; padding: 7px 0; }
.brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* A real top-level heading, because the page had none: a screen reader's "jump to the
   heading" found nothing to jump to. Styled back down to the size it always was — it is
   a name in a toolbar, not a title on a poster. */
.brand h1 { font-size: 15px; font-weight: 640; letter-spacing: -.015em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; }
.brand span { color: var(--muted); font-size: 12.5px; white-space: nowrap; }

/* Status, not a control: a filled pill with no border, so it never reads as pressable. */
.live {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2);
  white-space: nowrap; background: color-mix(in srgb, var(--ink) 5%, transparent);
  border-radius: 999px; padding: 3px 10px 3px 8px; font-weight: 520;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.on { background: var(--good-text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good-text) 22%, transparent); }
.dot.off { background: var(--crit-text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--crit-text) 20%, transparent); }
.grow { flex: 1 1 auto; min-width: 8px; }

.head-links { display: flex; gap: 6px; flex-wrap: wrap; }
/* A hairline between "somewhere else" and "do something here". */
.head-actions { display: flex; gap: 6px; align-items: center; }
.head-links:not(:empty) + .head-actions { padding-left: 12px; border-left: 1px solid var(--line); }

.nav-row { display: flex; align-items: flex-end; gap: 20px; }
.facts {
  display: flex; gap: 14px; flex-wrap: wrap; margin-left: auto;
  font-size: 11.5px; color: var(--muted); padding-bottom: 9px; min-width: 0;
}
.facts span { white-space: nowrap; }
/* Sibling instances. A dashboard reports on one process, and this is the honest amount
   of help the page can give with that: a way to reach the others. */
.peers { display: flex; gap: 6px; align-items: center; padding-bottom: 7px; flex-wrap: wrap; }
.peers a { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; }
@media (max-width: 900px) { .peers { display: none; } }
.facts b { font-weight: 600; color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* Secondary by definition, so it is the first thing to go when room runs out. */
@media (max-width: 900px) { .facts { display: none; } }
@media (max-width: 560px) { .brand span { display: none; } }
button, .linkbtn {
  font: inherit; font-size: 12.5px; line-height: 1.4; padding: 6px 11px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
  cursor: pointer; white-space: nowrap; text-decoration: none; display: inline-block;
}
button:hover, .linkbtn:hover { background: var(--surface-2); color: var(--ink); border-color: color-mix(in srgb, var(--ink) 22%, var(--line)); }
button[aria-pressed="true"] { background: color-mix(in srgb, var(--s1) 12%, var(--surface)); border-color: color-mix(in srgb, var(--s1) 45%, var(--line)); color: var(--ink); }
button[disabled] { opacity: .5; cursor: default; }

.tabs { display: flex; gap: 2px; margin-bottom: -1px; flex: none; }
.tab {
  border: 0; background: none; border-bottom: 2px solid transparent; border-radius: 0;
  padding: 9px 12px; font-size: 13px; color: var(--muted); font-weight: 500;
}
.tab:hover { background: none; color: var(--ink); }
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--s1); }

/* --- layout ------------------------------------------------------------- */
/* The top padding is the gap under the sticky header. At 18px the counter row sat almost
   against the header's border and read as part of it; the tiles carry their own border, so
   two lines were meeting with nothing between them. */
main { padding: 28px 20px 64px; max-width: 1680px; margin: 0 auto; }
.stack { display: grid; gap: 16px; }
/* Everything above the feed is drawn by script once the first snapshot arrives, which
   inserts a block of content above what is already laid out. The browser's scroll
   anchoring compensates for that by scrolling down by its height — so on any window narrow
   enough for the counter row to wrap, the dashboard opened with its own counters already
   off the top of the screen, every time.

   Anchoring is switched off for the first render and switched back on once it has settled
   (see settleScrollAnchoring in the client). It is not simply left off: the feed puts new requests at
   the top, and anchoring is exactly what keeps somebody's place while they read a screen
   that grows above them. */
.tiles { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); }
.tile {
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 12px 9px; box-shadow: var(--shadow);
}
.tile .v { font-size: 21px; font-weight: 620; letter-spacing: -.025em; line-height: 1.15; }
.tile .k { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .055em; margin-top: 2px; font-weight: 560; }
/* One line, always. These are grid items, so the tallest sets the height of all nine —
   two captions wrapping to a second line was costing every tile forty pixels of nothing.
   The full text stays available on hover rather than being cut from the page. */
.tile .s { font-size: 11px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A tile that navigates is a real button, so it arrives carrying the browser's own
   font, centring and chrome. Reset to match its inert neighbours exactly, then given
   back the one thing a div must not have: something that says it can be pressed. */
button.tile {
  font: inherit; color: inherit; text-align: left; width: 100%; display: block;
  cursor: pointer; appearance: none; transition: border-color .12s, box-shadow .12s;
}
button.tile:hover { border-color: var(--focus); }
/* The suggestion list under the search box, positioned against the search wrapper. */
.search { position: relative; }
.suggest {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; margin: 0; padding: 4px;
  list-style: none; min-width: 220px; max-height: 260px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line); border-radius: 9px; box-shadow: var(--shadow);
}
.suggest li { padding: 4px 9px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.suggest li[aria-selected="true"] { background: color-mix(in srgb, var(--focus) 18%, transparent); }

/* Saved filters: a list of small removable things. Quiet, because it is not what
   somebody came to the page to look at. */
.saved { display: flex; align-items: center; gap: 6px; }
/* Two open-ended bounds rather than a list of durations: "from the incident until now",
   "everything up to when it stopped" and "between these two moments" are the same control
   with one end left empty. */
.timeframe { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
.timeframe label { display: inline-flex; align-items: center; gap: 4px; }
.timeframe input {
  font: inherit; font-size: 11.5px; padding: 2px 5px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
}
.timeframe button { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
.saved select { font: inherit; font-size: 11.5px; padding: 3px 6px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); max-width: 170px; }
.saved button { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
.saved button:hover { border-color: var(--focus); }

/* The badge's companion: fetches the entries the stream skipped. Sits inline with the
   heading, so it is styled to read as part of the sentence rather than as a form control. */
.load-skipped {
  font: inherit; margin-left: 6px; padding: 1px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--warn-text); background: transparent; color: var(--warn-text);
}
.load-skipped:hover { background: color-mix(in srgb, var(--warn-text) 12%, transparent); }
.load-skipped:disabled { opacity: .5; cursor: default; }

/* Prev/next under a table. Quiet: it is navigation for a list, not an action on it. */
.pager {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 2px 2px; font-size: 12px; color: var(--muted);
}
.pager button {
  font: inherit; padding: 4px 11px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer;
}
.pager button:hover:not(:disabled) { border-color: var(--focus); }
.pager button:disabled { opacity: .45; cursor: default; }
.pager .where { font-variant-numeric: tabular-nums; }
/* A labelled actor leads with its name and keeps the key underneath: whoever named it did
   so because the key was not the useful part, and the key is still what you search for. */
td.who .label { font-weight: 560; }
td.who .sub { color: var(--muted); font-size: 11px; }
.pager.pager-top { padding: 2px 2px 9px; border-bottom: 1px solid var(--line); margin-bottom: 9px; }
/* The feed's upper pager rides in the toolbar rather than owning a row of its own, which
   was thirty-six pixels of mostly empty rule above every screenful of requests. */
.pager.pager-inline { padding: 0; margin-left: auto; gap: 8px; }
.pager.pager-inline .size { margin-left: 0; }
.pager .step { min-width: 30px; font-size: 15px; line-height: 1; padding: 3px 8px 5px; }
.pager .size { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.pager .size select {
  font: inherit; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
}
.pager .held { color: var(--warn-text); }
.tile.good .v { color: var(--good-text); }
.tile.warn .v { color: var(--warn-text); }
.tile.crit .v { color: var(--crit-text); }
.tile.proven .v { color: var(--proven-text); }

/* "clip" rather than "hidden", and the difference is load-bearing. Both round off the
   corners, but "hidden" makes the panel a scroll container — which becomes the
   containing block for anything sticky inside it, so the feed's column headers were
   anchored to a box that never scrolls and simply never stuck. They have not worked
   since they were written; the hard-coded offset above them was dead code. "clip"
   clips without creating a scrollport, so the headers stick to the viewport, under
   the page header, where they were always meant to. */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: clip; }
.panel > h2 {
  margin: 0; padding: 9px 14px; font-size: 11.5px; font-weight: 620; color: var(--muted);
  text-transform: uppercase; letter-spacing: .055em; border-bottom: 1px solid var(--line);
  display: flex; align-items: center; gap: 10px;
}
.panel > h2 .sub { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 11.5px; margin-left: auto; }
/* A container, so the two-column grid below can ask how much room it actually has.

   It used to ask the viewport, which is the same mistake the feed table's breakpoints
   made one level down: the constraint is the width of this column, not of the window.
   Embedded in a 320px sidebar on a 1280px screen the media query never fired, the second
   column held its 280px minimum, and the feed was squeezed to twenty-two pixels. */
.stack { container: dash / inline-size; }
/* A grid item's min-width is auto, so a panel wrapping a wide table refuses to shrink and
   pushes the whole document sideways instead — which is what the Actors screen did under
   about 600px, where the table is widest and the viewport narrowest. The .two grid already
   says minmax(0, ...) for this reason; .stack needs the same permission. With it the panel
   shrinks and the scroller inside it does its job. */
.stack > * { min-width: 0; }
/* Numeric columns shrink to their contents, so the width goes to the two columns that
   carry text — the actor and what is known about it. Six counters of one or two digits
   were each taking about a hundred pixels while the State column was squeezed against the
   buttons. Same trick the feed's time column already uses. */
#view-actors th.num, #view-actors td.num { width: 1%; white-space: nowrap; }
.two { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.9fr) minmax(280px, 1fr); align-items: start; }
.grid3 { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
@container dash (max-width: 1080px) { .two { grid-template-columns: minmax(0, 1fr); } }

/* The feed table has a floor — six columns of request text will not go below about
   940px — and under it the panel was simply amputating the right-hand columns.

   These are **container** queries, not media queries, and the difference is the whole
   fix. What the table has to fit inside is the panel, and the panel is one column of a
   two-column grid: at a 1400px viewport it is about 880px wide, so a viewport-based
   breakpoint at 980px never fires and the right-hand columns are clipped on a perfectly
   ordinary desktop. That is exactly the bug a media query was written to fix, and the
   media query was measuring the wrong box the whole time. It only appeared to work
   because five columns happened to fit.

   Four things happen on the way down, in the order that costs least. First the
   duration goes: it is the column people narrow a window least to read and it is still
   in the row detail. Then the timestamp, which is also still in the row detail and is
   implied by the order while the stream is live. Then the User-Agent line stops
   ellipsing and wraps, which is what actually buys the room — it takes the table's floor
   from about 100ch to about 56ch, because the cap on that one line is most of what the
   table cannot go below. Only under *that* does the table get a scrollbar of its own.

   The scrollbar is deliberately last and deliberately rare, and it is worth being
   precise about why, because it is the rung that gets set too high. A scroll container
   is the containing block for anything sticky inside it, so the moment it turns on the
   column headers stop tracking the viewport — and a row becomes wider than the box it
   sits in, which is enough to make it hard to click and, for a keyboard or a pointer
   being driven by a test, hard to reach at all. It cost both when it fired at 1440px on
   a wider face: the headers scrolled away with the rows and a click on a row never
   landed. Wrapping costs a line of height and nothing else, so it goes first and this
   goes last.

   The thresholds are in **ch**, and that is the second half of the same lesson. They
   used to be pixels, which quietly assumed a font: what six columns of request text
   actually need is set by the width of a glyph — the User-Agent below is capped in ch —
   and a hard pixel breakpoint is only correct for the font it was measured on. On this
   machine the six columns needed 951px and the breakpoint sat at 960px, so it passed by
   nine pixels; on a CI runner with a wider default face the same six columns needed more
   than the panel had, the query did not fire, and the right-hand columns were clipped on
   an ordinary 1600px desktop. The five-column rung was already over its own floor by
   8px and nobody had noticed, because nothing measures a layout that merely looks fine.

   In ch, both sides move together: a wider face makes the content wider and makes the
   threshold wider by the same proportion. The floors, measured, are 119ch / 111ch /
   100ch ellipsing and 56ch wrapped, and each rung sits above its own floor with room to
   spare so that the arithmetic does not have to be exact. */
.feed-panel { container: feed / inline-size; }

/* The rungs themselves are further down, immediately after the table's own rules, and
   they have to be: a container query adds no specificity, so an override written above
   the declaration it overrides simply loses on source order and does nothing. The wrap
   rung sat here for exactly that reason and was dead the whole time — the table never
   wrapped, its floor never dropped, and nothing said so. See "the column ladder" below. */

/* The header's own subtitle, which is a viewport thing rather than a panel thing: it
   sits in the page header and has no container to be measured against. */
@media (max-width: 700px) {
  .sub { white-space: normal; max-width: none; }
}

/* --- feed table --------------------------------------------------------- */
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 15px; border-bottom: 1px solid var(--line); }
.filters { display: flex; gap: 5px; flex-wrap: wrap; }
.filters button { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; }
input[type="search"] {
  font: inherit; font-size: 12.5px; padding: 5px 10px; min-width: 180px; flex: 1 1 180px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--ink);
}
input[type="search"]::placeholder { color: var(--muted); }

/* separate with zero spacing rather than collapse, and the difference is the whole
   reason the column headers work in Safari.

   Collapsed borders and sticky table cells are a long-standing sore point in WebKit: the
   CSSWG has an open issue on collapsed borders not following a cell when it sticks
   (csswg-drafts#3136), and Safari is widely reported to drop the stickiness of a th
   altogether under a collapsed table. Separating the borders is the standard remedy.

   What was actually measured: the header sticks correctly in Chromium and in Firefox,
   both before and after this change, and it was reported adrift in Safari — which is what
   a sticky element that has stopped sticking looks like. WebKit could not be run on the
   machine this was written on, so the Safari half of it rests on that report and on the
   documented behaviour rather than on a measurement taken here.

   The rendering is all but unchanged. Every border in these tables is a bottom border on
   the cell itself, plus the per-cell left accent on td.edge; no border is shared between
   two cells, so there is nothing for collapsing to merge and nothing for separating to
   double, and zero spacing keeps the cells touching. The one measurable difference is the
   accent column, which moves two pixels: collapsing centres that 3px border on the cell
   edge and leaves half of it outside the box, while separating puts all of it inside.
   Measured rather than assumed, and the leftmost column starting two pixels earlier is
   both imperceptible and the more correct of the two. */
table { width: 100%; border-collapse: separate; border-spacing: 0; }
thead th {
  /* Measured at runtime — see trackHeaderHeight(). The literal is the fallback for
     the instant before the first measurement, and for the tab strip wrapping. */
  position: sticky; top: var(--header-h, 91px); z-index: 2; background: var(--surface);
  text-align: left; font-size: 11px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: .05em; padding: 9px 15px; border-bottom: 1px solid var(--line);
}
tbody td { padding: 7px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
/* Narrow, quiet, and never the reason a row wraps: the time is for scanning down, not
   for reading across. */
tbody td.when { color: var(--muted); font-size: 11.5px; white-space: nowrap; width: 1%; padding-right: 4px; }
tbody tr.row { cursor: pointer; }
tbody tr.row:hover { background: color-mix(in srgb, var(--ink) 3.5%, transparent); }
tbody tr.row.open { background: color-mix(in srgb, var(--s1) 7%, transparent); }
td.edge { border-left: 3px solid transparent; padding-left: 12px; }
tr.a-allow td.edge { border-left-color: var(--good-text); }
tr.a-mitigate td.edge { border-left-color: var(--s2); }
tr.a-deny td.edge { border-left-color: var(--crit); }
tr.a-guard td.edge { border-left-color: var(--warn-text); }
.req { font-size: 12.5px; overflow-wrap: anywhere; }
/* The disclosure for a row.
   The whole row used to be role="button", with the actor link inside it — a control
   nested in a control, which leaves a screen reader with two things to announce and no
   way to say which one Enter belongs to. The row still opens on click, because that is
   a convenience rather than a role; the keyboard gets this, which is one control with
   one name and one job. */
.row-toggle {
  border: 0; background: none; padding: 0; margin: 0; border-radius: 4px;
  font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; color: inherit; text-align: left; cursor: pointer; display: block; width: 100%;
}
.row-toggle:hover { background: none; color: inherit; border-color: transparent; }
.req .ua { color: var(--muted); font-size: 11.5px; display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 64ch; }
.req .ua a { color: inherit; text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--muted) 60%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.req .ua a:hover { color: var(--ink); border-bottom-color: var(--ink); }
.num { text-align: right; }

/* The column ladder. Read the note beside .feed-panel above for what it is for and why
   the thresholds are in ch; this is where it has to live, below every declaration it
   overrides. */
@container feed (max-width: 128ch) {
  thead th:nth-child(6), tbody td:nth-child(6) { display: none; }
}
@container feed (max-width: 119ch) {
  thead th:nth-child(1), tbody td.when { display: none; }
}
@container feed (max-width: 107ch) {
  .req .ua { white-space: normal; max-width: none; }
}
@container feed (max-width: 62ch) {
  .feed-scroll { overflow-x: auto; }
}

.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.b-proven { background: color-mix(in srgb, var(--proven-text) 14%, transparent); color: var(--proven-text); }
.b-suspected { background: color-mix(in srgb, var(--warn-text) 16%, transparent); color: var(--warn-text); }
.b-human { background: color-mix(in srgb, var(--good-text) 14%, transparent); color: var(--good-text); }
/* The secondary ink rather than the muted one, for the same reason as the weak tier:
   muted ink on its own muted chip is 4.31:1 on a plain row and 3.70:1 on an open one. */
.b-unknown { background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--ink-2); }
.act { font-weight: 600; font-size: 12.5px; }
.act-allow { color: var(--good-text); }
.act-mitigate { color: var(--warn-text); }
.act-deny { color: var(--crit-text); }
.act-tag { color: var(--ink-2); }
.sub { color: var(--muted); font-size: 11.5px; display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 22ch; }
.guard { color: var(--warn-text); font-size: 11.5px; display: block; margin-top: 3px; font-weight: 500; }

tr.detail > td { background: var(--surface-2); padding: 14px 15px 16px; border-bottom: 1px solid var(--line); }
.ev { display: grid; gap: 9px; }
.ev-item { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 12.5px; }
.tier { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 3px 6px; border-radius: 6px; text-align: center; }
.t-certain { background: color-mix(in srgb, var(--proven-text) 15%, transparent); color: var(--proven-text); }
.t-strong { background: color-mix(in srgb, var(--crit-text) 14%, transparent); color: var(--crit-text); }
.t-moderate { background: color-mix(in srgb, var(--warn-text) 16%, transparent); color: var(--warn-text); }
/* The secondary ink rather than the muted one: muted ink on its own muted chip clears
   4.5:1 on the light surface and does not on the dark one, and this is 10px bold text
   saying how much a piece of evidence is worth. It still reads as the quiet tier — the
   only one with no hue — without being the one nobody can read at night. */
.t-weak { background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--ink-2); }
.ev-item.human .tier { background: color-mix(in srgb, var(--good-text) 14%, transparent); color: var(--good-text); }
.ev-meta { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.basis { margin-top: 5px; color: var(--ink-2); font-size: 12px; border-left: 2px solid color-mix(in srgb, var(--proven-text) 40%, transparent); padding: 2px 0 2px 9px; }
.detail-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; display: flex; gap: 14px; flex-wrap: wrap; }

/* --- bars --------------------------------------------------------------- */
.bars { padding: 12px 15px 14px; display: grid; gap: 8px; }
.bar { display: grid; grid-template-columns: minmax(0, 1fr) 46px; gap: 10px; align-items: center; font-size: 12.5px; }
.bar .track { position: relative; height: 20px; background: color-mix(in srgb, var(--ink) 5%, transparent); border-radius: 6px; overflow: hidden; }
.bar .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--s1) 26%, transparent); border-radius: 0 5px 5px 0; }
.bar .lbl { position: relative; padding: 0 8px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .v { text-align: right; color: var(--ink-2); font-size: 12px; }

/* --- charts ------------------------------------------------------------- */
.chart { padding: 12px 15px 14px; position: relative; }
.chart svg { display: block; width: 100%; overflow: visible; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 15px 12px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
/* The marker for a runtime change. A line rather than a swatch, because it is an
   instant rather than a quantity. */
.legend .mark { width: 2px; height: 11px; background: var(--proven-text); border-radius: 1px; flex: none; }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.tip {
  position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.16); z-index: 10; min-width: 128px;
}
.tip .t { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.tip .r { display: flex; align-items: center; gap: 7px; justify-content: space-between; }
.tip .r em { font-style: normal; color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px; }
.tip .r b { font-weight: 600; font-variant-numeric: tabular-nums; }

.stat-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 15px; font-size: 12.5px; border-bottom: 1px solid var(--line-soft); }
.stat-row:last-child { border-bottom: 0; }
.stat-row .k { color: var(--muted); }
.stat-row .v { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 560; }
/* The baseline a window is being read against. Quieter than the current value, and
   beside it rather than under it, because the comparison is the whole point. */
.stat-row .v .was { color: var(--muted); font-weight: 400; font-size: 11.5px; }
.note { padding: 13px 15px; font-size: 12.5px; color: var(--ink-2); }
.note p { margin: 0 0 9px; }
.note p:last-child { margin: 0; }
.note b { color: var(--ink); }
.empty { padding: 40px 15px; text-align: center; color: var(--muted); font-size: 13px; }
.empty code { background: color-mix(in srgb, var(--ink) 7%, transparent); padding: .15em .4em; border-radius: 5px; }
.detectors { padding: 4px 0; }
.det { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 8px 15px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
.det:last-child { border-bottom: 0; }
.det .d { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.det .n { color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rules { padding: 10px 15px; display: flex; gap: 6px; flex-wrap: wrap; }
.rules .chip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
[hidden] { display: none !important; }
/* Present to a screen reader, absent to everyone else. Clipped rather than moved
   off-screen or hidden with display:none, both of which take an element out of the
   accessibility tree along with the viewport. */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; white-space: nowrap; clip-path: inset(50%); border: 0; }

/* --- navigation --------------------------------------------------------- */
/* Present for a keyboard, out of the way of everything else. */
.skip {
  position: absolute; left: 10px; top: 10px; z-index: 40;
  background: var(--raised); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 13px; font-size: 12.5px; text-decoration: none;
  /* Hidden by clipping rather than by being moved off-screen. An element parked
     above the viewport has its whole border box outside it, and Chrome's sequential
     focus navigation skips those — so a skip link done that way is invisible to the
     one input device it exists for. Clipped to a pixel it stays in the tab order. */
  width: 1px; height: 1px; padding: 0; overflow: hidden; white-space: nowrap; clip-path: inset(50%);
}
.skip:focus { width: auto; height: auto; padding: 8px 13px; overflow: visible; clip-path: none; }

/* A row is a control now, so it has to look like one when focused. outline-offset
   is negative because an outline drawn outside a table row is clipped by the cell. */
tbody tr.row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
tbody tr.row:focus-visible td.edge { border-left-color: var(--focus); }

.search { position: relative; display: flex; flex: 1 1 180px; min-width: 180px; }
.search input[type="search"] { flex: 1 1 auto; padding-right: 26px; }
.search kbd {
  position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  font: 500 10.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); background: color-mix(in srgb, var(--ink) 6%, transparent);
  border: 1px solid var(--line); border-radius: 4px; padding: 3px 5px; pointer-events: none;
}
/* The hint is an affordance for a mouse user who has not found the key yet. Once the
   box is in use it is noise, and it sits where the clear button wants to be. */
.search input[type="search"]:focus + kbd, .search input[type="search"]:not(:placeholder-shown) + kbd { display: none; }
/* --- added panels ------------------------------------------------------- */
.range { display: flex; gap: 4px; }
.range button { font-size: 11px; padding: 2px 8px; border-radius: 999px; }

.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; padding: 12px 15px; font-size: 12.5px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }

.hdr { width: 100%; border-collapse: collapse; margin-top: 10px; }
.hdr td { padding: 3px 8px 3px 0; vertical-align: top; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; border: 0; }
.hdr td.n { color: var(--muted); white-space: nowrap; width: 1%; }
.hdr td.v { overflow-wrap: anywhere; }
.hdr td.v.red { color: var(--muted); font-style: italic; }

.tools { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.tools button { font-size: 11.5px; padding: 4px 9px; }

.editor { padding: 12px 15px 14px; display: grid; gap: 10px; }
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5;
  width: 100%; min-height: 320px; resize: vertical; padding: 11px 12px; tab-size: 2;
  border: 1px solid var(--line); border-radius: 9px; background: var(--surface-2); color: var(--ink);
}
textarea[readonly] { opacity: .8; }
.editor-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.result { font-size: 12.5px; border-radius: 9px; padding: 10px 12px; border: 1px solid var(--line); background: var(--surface-2); }
.result.ok { border-color: color-mix(in srgb, var(--good-text) 45%, var(--line)); }
.result.bad { border-color: color-mix(in srgb, var(--crit-text) 45%, var(--line)); color: var(--crit-text); }
.result.warn { border-color: color-mix(in srgb, var(--warn-text) 45%, var(--line)); }
.result b { font-weight: 620; }
.diff { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
.diff th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); }
.diff td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.diff .from { color: var(--muted); }
.diff .to { font-weight: 600; }
.diff .to.deny { color: var(--crit-text); }
.diff .to.allow { color: var(--good-text); }
pre.code {
  margin: 0; padding: 11px 12px; border-radius: 9px; border: 1px solid var(--line);
  background: var(--surface-2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.5; overflow-x: auto; white-space: pre; color: var(--ink-2);
}
.notice { display: grid; grid-template-columns: 74px 1fr; gap: 10px; padding: 8px 15px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
.notice:last-child { border-bottom: 0; }
.notice .when { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.notice.warning .tag { color: var(--warn-text); font-weight: 600; }
.notice.error .tag { color: var(--crit-text); font-weight: 600; }
.dead { color: var(--muted); }
.dead .lbl { text-decoration: line-through; }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
.actor-head { display: flex; align-items: center; gap: 10px; padding: 12px 15px; border-bottom: 1px solid var(--line); }
.actor-head .who { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; font-weight: 600; }
/* --- the rule editor ----------------------------------------------------- */
.bar-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 10px 15px; border-bottom: 1px solid var(--line); background: var(--surface); }
.bar-actions + .bar-actions, .rulelist + .bar-actions { border-bottom: 0; border-top: 1px solid var(--line); }
.bar-actions .grow { flex: 1 1 auto; }
button.primary { background: var(--accent-solid); border-color: var(--accent-solid); color: #fff; font-weight: 560; }
button.primary:hover { background: color-mix(in srgb, var(--accent-solid) 86%, #000); border-color: transparent; color: #fff; }
button.danger { color: var(--crit-text); }
button.danger:hover { border-color: color-mix(in srgb, var(--crit-text) 50%, var(--line)); }
button.icon { padding: 3px 8px; font-size: 12px; line-height: 1.2; }
.dirty { font-size: 11.5px; color: var(--warn-text); font-weight: 560; display: inline-flex; align-items: center; gap: 6px; }
.dirty::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--warn-text); }

.rulelist { display: grid; gap: 12px; padding: 14px 15px 16px; }
.rule {
  border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2);
  transition: border-color .12s, box-shadow .12s;
}
.rule:focus-within { border-color: color-mix(in srgb, var(--s1) 55%, var(--line)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--s1) 12%, transparent); }
.rule.locked { background: color-mix(in srgb, var(--ink) 3%, var(--surface)); }
.rule-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex-wrap: nowrap; }
.rule:not(.collapsed) .rule-head { border-bottom: 1px solid var(--line); }
.rule-head .ord { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 20px; text-align: right; }
.rule-head input[type="text"] { flex: 0 1 240px; width: auto; min-width: 130px; }
.rule-head select { flex: 0 0 auto; }
.chev { border: 0; background: none; padding: 2px 4px; color: var(--muted); font-size: 11px; line-height: 1; }
.chev:hover { background: none; color: var(--ink); }
.rule-summary { flex: 1 1 auto; display: flex; gap: 5px; flex-wrap: wrap; align-items: center; min-width: 0; overflow: hidden; }
.rule-summary .k { font-size: 10.5px; color: var(--muted); }
.rule-summary .t { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--ink) 6%, transparent); color: var(--ink-2); white-space: nowrap; }
.rule-summary .none { font-size: 11px; color: var(--muted); font-style: italic; }
.act-pill { font-size: 11px; font-weight: 620; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
.act-pill.deny { background: color-mix(in srgb, var(--crit-text) 14%, transparent); color: var(--crit-text); }
.act-pill.mitigate { background: color-mix(in srgb, var(--warn-text) 16%, transparent); color: var(--warn-text); }
.act-pill.allow { background: color-mix(in srgb, var(--good-text) 14%, transparent); color: var(--good-text); }
.act-pill.tag { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink-2); }
.rule-body { padding: 11px 12px 13px; display: grid; gap: 11px; }
.rule.collapsed .rule-body { display: none; }
.field { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 12.5px; }
.field > label { color: var(--muted); padding-top: 5px; }
.field-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hint { color: var(--muted); font-size: 11px; }

input[type="text"], input[type="number"], select {
  font: inherit; font-size: 12.5px; padding: 5px 9px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); min-width: 0;
}
input[type="text"] { width: 100%; }
input[type="number"] { width: 92px; }
select { cursor: pointer; }
input::placeholder { color: color-mix(in srgb, var(--muted) 80%, transparent); }
.mono-input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.chips-select { display: flex; gap: 4px; flex-wrap: wrap; }
.chips-select button {
  font-size: 11px; padding: 2px 8px; border-radius: 999px; color: var(--muted);
  background: var(--surface); border: 1px solid var(--line);
}
.chips-select button[aria-pressed="true"] { background: color-mix(in srgb, var(--s1) 14%, var(--surface)); border-color: color-mix(in srgb, var(--s1) 50%, var(--line)); color: var(--ink); font-weight: 560; }

.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 4px 10px; font-size: 11.5px; background: var(--surface); }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--s1) 14%, var(--surface)); color: var(--ink); font-weight: 560; }

.drop { outline: 2px dashed color-mix(in srgb, var(--s1) 60%, transparent); outline-offset: -6px; }

/* --- the actors table, the tester and the range sets --------------------- */
.warn-text { color: var(--warn-text); }
#actor-rows td { font-size: 12.5px; }
#actor-rows td.who { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
#actor-rows td.acts { text-align: right; white-space: nowrap; }
/* The tracked/shown toggle above the actors table. A segmented pair rather than a
   dropdown: there are two answers and both are worth reading at a glance. */
.scope { display: flex; gap: 6px; padding: 0 14px 10px; }
.scope button { font-size: 11.5px; padding: 4px 10px; }
.scope button.on { background: var(--accent); color: var(--on-accent, #fff); border-color: var(--accent); }

#actor-rows td.acts button { font-size: 11px; padding: 3px 8px; margin-left: 4px; }
/* The Label control, which becomes a text box with a Save and a Cancel in place.

   The cell does not wrap, so an editor that sat beside the row's other four buttons put
   Save off the right edge of the panel, where it could be seen and not clicked. While
   the editor is open it stands in for those buttons instead — which is also the right
   thing on its own, since Allowlist and Forget are not what somebody naming a client is
   reaching for. */
.acts.editing > :not(.label-edit), .bar-actions.editing > :not(.label-edit) { display: none; }
/* inline-flex rather than inline-block: the row is three fixed-size controls and a flex
   line is the layout that cannot spill them past its own edge. */
.label-edit { display: inline-flex; align-items: center; gap: 4px; }
.label-edit button { flex: 0 0 auto; }
#actor-rows td.acts .label-save, #actor-actions .label-save { border-color: var(--accent); color: var(--accent); }
/* Qualified with the element name on purpose: input[type="text"] { width: 100% } above
   outranks a bare class, so the width here was quietly ignored and the box grew to fill
   whatever it was in — which is what put Save and Cancel outside the panel. */
input.label-input {
  font: inherit; font-size: 11px; padding: 3px 8px; width: 15ch; flex: 0 0 auto; box-sizing: border-box;
  color: var(--ink); background: var(--surface); border: 1px solid var(--accent); border-radius: 6px;
}
input.label-input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

/* A tag, not a warning: a cleared actor is a decision somebody made, and a metronomic
   one is a measurement. Neither is a verdict, so neither gets a verdict's colour. */
/* A shadowed finding: shown at full detail, and visibly not part of the decision. Dimmed
   and set behind a rule rather than coloured, because every colour on this page already
   means something about a verdict and this one took no part in a verdict. */
.det.shadow { opacity: 0.72; }
.ev-item.shadow { opacity: 0.72; border-left: 2px dashed var(--line); padding-left: 8px; }
.shadow-verdict { margin-top: 8px; font-style: italic; }
.shadow-verdict.changed { color: var(--ink-2); font-style: normal; }
/* A named actor. Set apart from an address by weight rather than colour: every colour on
   the feed already means something about a verdict, and a name means nothing about one. */
.ua a.labelled { font-weight: 600; }
.actor-label { font-weight: 600; font-size: 14px; margin-right: 8px; }
.label-note b { font-weight: 600; color: var(--ink); }
.tagline { font-size: 11px; color: var(--muted); }
.tagline b { color: var(--ink-2); font-weight: 600; }

#test-input { min-height: 82px; }
#tester-panel .editor { gap: 8px; }
#tester-panel .field-row { gap: 6px; }
#tester-panel input[type="text"] { flex: 1 1 120px; min-width: 90px; }
.assumed { color: var(--muted); font-size: 11px; margin-top: 6px; }

.rangeset { border-bottom: 1px solid var(--line-soft); padding: 10px 15px; }
.rangeset:last-child { border-bottom: 0; }
.rangeset h3 { margin: 0 0 6px; font-size: 12.5px; font-weight: 620; display: flex; align-items: baseline; gap: 8px; }
.rangeset h3 span { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.cidrs { display: flex; gap: 5px; flex-wrap: wrap; }
.cidr {
  display: inline-flex; align-items: center; gap: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 999px; padding: 2px 4px 2px 9px;
}
.cidr button { border: 0; background: none; padding: 0 4px; font-size: 12px; line-height: 1; color: var(--muted); border-radius: 999px; }
.cidr button:hover { background: none; color: var(--crit-text); }
.cidr.readonly { padding-right: 9px; }
.toasts { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: grid; gap: 8px; max-width: 380px; }
.toast {
  background: var(--raised); border: 1px solid var(--line); border-left: 3px solid var(--s1);
  border-radius: 9px; padding: 10px 12px; font-size: 12.5px; box-shadow: 0 6px 22px rgba(0,0,0,.18);
  animation: toast-in .16s ease-out;
}
.toast.ok { border-left-color: var(--good-text); }
.toast.bad { border-left-color: var(--crit-text); }
.toast.warn { border-left-color: var(--warn-text); }
.toast b { display: block; margin-bottom: 2px; }
.toast span { color: var(--muted); }
@keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } * { transition: none !important; } }

/* Forced colours — Windows High Contrast and the like.
   The browser repaints text, backgrounds and borders from the user's palette but leaves
   SVG fill and stroke alone, which is the right outcome for the two series: they stay
   tellable apart instead of collapsing into one system colour. The gridlines are the
   casualty. They are drawn in --grid, a colour picked to recede against *this* dashboard's
   background, and against a forced black one they recede to 1.4:1 — measured, on the
   statistics charts — which is not recessive, it is gone. GrayText is the palette's own
   answer to "present but secondary", so the grid follows the user's colours while the data
   keeps the ones that carry meaning. */
@media (forced-colors: active) {
  .gridline { stroke: GrayText; }
}`;

/**
 * Everything between `<body>` and the boot script.
 *
 * The standalone page and the embedded element render identical markup; only what they
 * render it *into* differs.
 */
export const DASHBOARD_MARKUP = String.raw`
<a class="skip" href="#view-live">Skip to the feed</a>

<header>
  <div class="head-row">
    <div class="brand"><h1 id="title">__TITLE__</h1> <span>bot dashboard</span></div>
    <output class="live" id="live" aria-live="polite"><span class="dot" id="dot"></span><span id="conn">connecting…</span></output>
    <div class="grow"></div>
    <nav class="head-links" id="links" aria-label="Related"></nav>
    <div class="head-actions">
      <button id="theme" aria-label="Switch between light and dark">Theme</button>
      <button id="pause" aria-pressed="false">Pause</button>
      <button id="reset" class="danger" hidden>Reset</button>
    </div>
  </div>
  <div class="nav-row">
    <div class="tabs" role="tablist" aria-label="Dashboard views">
      <button class="tab" id="tab-live" role="tab" aria-selected="true" aria-controls="view-live">Live feed</button>
      <button class="tab" id="tab-actors" role="tab" aria-selected="false" aria-controls="view-actors">Actors</button>
      <button class="tab" id="tab-stats" role="tab" aria-selected="false" aria-controls="view-stats">Statistics</button>
      <button class="tab" id="tab-policy" role="tab" aria-selected="false" aria-controls="view-policy">Policy<span id="notice-badge" class="pill" hidden></span></button>
    </div>
    <div class="facts" id="chips"></div>
    <div class="peers" id="peers"></div>
  </div>
</header>

<main class="stack">
  <section class="tiles" id="tiles"></section>

  <div id="view-live" role="tabpanel" aria-labelledby="tab-live" class="stack">
    <section class="panel" id="actor-panel" hidden>
      <div class="actor-head">
        <span class="actor-label" id="actor-label" hidden></span>
        <span class="who" id="actor-key"></span>
        <span class="grow"></span>
        <button id="actor-close">Close</button>
      </div>
      <div class="two">
        <dl class="kv" id="actor-stats"></dl>
        <div class="bars" id="actor-mix"></div>
      </div>
      <div class="bar-actions" id="actor-actions"></div>
    </section>

    <div class="two">
      <section class="panel feed-panel">
        <h2>Requests <span class="sub" id="feed-count"></span><span class="sub win" id="feed-window"></span><span class="sub warn-text" id="feed-skipped" hidden></span><button class="sub load-skipped" id="feed-load-skipped" type="button" hidden>Load them</button></h2>
        <div class="toolbar">
          <div class="filters" id="filters"></div>
          <div class="search">
            <input type="search" id="search" placeholder="path:/api  actor:203.0.113.4  -rule:allow-crawlers" spellcheck="false" autocomplete="off"
                   role="combobox" aria-expanded="false" aria-controls="search-suggest" aria-autocomplete="list">
            <kbd aria-hidden="true">/</kbd>
            <ul class="suggest" id="search-suggest" role="listbox" aria-label="Filter suggestions" hidden></ul>
          </div>
          <div class="saved" id="saved-filters"></div>
          <div class="timeframe" id="timeframe">
            <label>From <input type="datetime-local" id="from-at" step="1"></label>
            <label>To <input type="datetime-local" id="to-at" step="1"></label>
            <button type="button" id="timeframe-clear" hidden>Clear</button>
          </div>
          <button id="feed-export" title="Download every request matching this filter as replay JSONL">Export</button>
          <div class="pager pager-inline" id="feed-pager-top" hidden></div>
        </div>
        <div class="feed-scroll">
        <table>
          <thead>
            <tr>
              <th class="num">Time</th><th>Request</th><th>Verdict</th><th class="num">Score</th><th>Action</th><th class="num">ms</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        </div>
        <div class="pager" id="feed-pager" hidden></div>
        <div class="empty" id="empty">Nothing assessed yet. Send some traffic through the handler and it appears here within a moment.</div>
      </section>

      <div class="stack">
        <section class="panel">
          <h2>Detectors firing <span class="sub win"></span></h2>
          <div class="bars" id="live-detectors"></div>
        </section>
        <section class="panel" id="live-actors-panel">
          <h2>Busiest actors <span class="sub win"></span></h2>
          <div class="bars" id="live-actors"></div>
        </section>
        <section class="panel" id="tester-panel">
          <h2>Test a request <span class="sub">nothing is recorded</span></h2>
          <div class="editor">
            <textarea id="test-input" rows="4" spellcheck="false" autocomplete="off" aria-label="A User-Agent, a curl command, or a block of request headers"
              placeholder="Paste a User-Agent, a curl command, or a block of request headers"></textarea>
            <div class="field-row">
              <input type="text" id="test-ip" class="mono-input" placeholder="client address (optional)" aria-label="Client address">
              <input type="text" id="test-url" class="mono-input" placeholder="/path (optional)" aria-label="Path">
              <button id="test-run" class="primary">Assess</button>
            </div>
            <div class="result" id="test-result" hidden></div>
          </div>
        </section>

        <section class="panel" id="evidence-legend">
          <h2>Reading this</h2>
          <div class="note">
            <p><b>Purple</b> evidence is <em>proven</em>: a self-declaration, a refuted
               identity, a trap, a protocol violation. Only proven evidence may deny anybody.</p>
            <p><b>Red, amber and grey</b> are probabilistic. They accumulate into a score
               and may tag, delay, rate-limit or challenge — never block.</p>
            <p>An <b>amber left edge</b> is the safety guard stopping a rule: the policy
               asked for a terminal action the evidence could not support, and got the
               fallback instead. Those rows are the library working, not failing.</p>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div id="view-actors" role="tabpanel" aria-labelledby="tab-actors" class="stack" hidden>
    <section class="panel">
      <h2>Actors in the registry <span class="sub" id="actors-count"></span></h2>
      <div class="note" id="actors-note">Everyone the engine is currently remembering, busiest first — a far larger
         population than the feed's ring, which holds requests rather than clients. This is
         what <code>cadence</code>, <code>crawl-breadth</code> and <code>rate-anomaly</code> are reading.</div>
      <div class="scope" role="group" aria-label="Which actors to list">
        <button id="actors-scope-tracked" class="on" aria-pressed="true"
          title="Every client the engine is remembering, busiest first">Tracked</button>
        <button id="actors-scope-feed" aria-pressed="false"
          title="Only the clients that appear in the feed you are looking at, after its filter">Shown in the feed</button>
      </div>
      <div class="pager pager-top" id="actors-pager-top" hidden></div>
      <div class="feed-scroll">
        <table>
          <thead>
            <tr>
              <th>Actor</th><th class="num">Requests</th><th class="num">Per min</th><th class="num">Paths</th>
              <th class="num">Cadence</th><th class="num">Proven</th><th class="num">Unsolved</th><th>State</th><th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody id="actor-rows"></tbody>
        </table>
      </div>
      <div class="pager" id="actors-pager" hidden></div>
      <div class="empty" id="actors-empty" hidden>Nothing in the registry yet.</div>
    </section>
  </div>

  <div id="view-stats" role="tabpanel" aria-labelledby="tab-stats" class="stack" hidden>
    <div class="two">
      <section class="panel">
        <h2>Traffic <span class="range" id="traffic-range"></span><span class="sub" id="traffic-window"></span></h2>
        <div class="chart" id="traffic-chart"><svg id="traffic" role="img" aria-labelledby="traffic-alt"></svg><div class="tip" id="traffic-tip"></div></div>
        <p class="sr-only" id="traffic-alt"></p>
        <div class="legend" id="traffic-legend"></div>
      </section>
      <section class="panel">
        <h2>Assessment latency <span class="sub">since start</span></h2>
        <div class="chart" id="latency-chart"><svg id="latency" role="img" aria-labelledby="latency-alt"></svg><div class="tip" id="latency-tip"></div></div>
        <p class="sr-only" id="latency-alt"></p>
        <div class="legend"><span id="latency-summary"></span></div>
      </section>
    </div>

    <div class="two">
      <section class="panel">
        <h2>Score distribution <span class="range" id="score-scope"></span><span class="sub" id="score-window"></span></h2>
        <div class="chart" id="score-chart"><svg id="scores" role="img" aria-labelledby="score-alt"></svg><div class="tip" id="score-tip"></div></div>
        <p class="sr-only" id="score-alt"></p>
        <div class="legend" id="score-legend"></div>
      </section>
      <section class="panel">
        <h2>Guard stops by rule <span class="sub win"></span></h2>
        <div class="bars" id="stat-guard"></div>
      </section>
    </div>

    <div class="grid3">
      <section class="panel"><h2>Verdicts <span class="sub">since start</span></h2><div class="bars" id="stat-verdicts"></div></section>
      <section class="panel"><h2>Actions taken <span class="sub">since start</span></h2><div class="bars" id="stat-actions"></div></section>
      <section class="panel"><h2>Bot classes <span class="sub">since start</span></h2><div class="bars" id="stat-classes"></div></section>
    </div>

    <div class="grid3">
      <section class="panel"><h2>Detector firings <span class="sub">since start</span></h2><div class="bars" id="stat-detectors"></div></section>
      <section class="panel">
        <h2>Challenges</h2>
        <div id="stat-challenges"></div>
      </section>
      <section class="panel">
        <h2>Health</h2>
        <div id="stat-health"></div>
      </section>
    </div>

    <div class="two">
      <section class="panel" id="audit-panel">
        <h2>Audit <span class="sub" id="audit-spans"></span></h2>
        <div id="audit-body"></div>
      </section>
      <section class="panel" id="audit-checks-panel">
        <h2>Checks installed</h2>
        <div class="detectors" id="audit-checks"></div>
      </section>
    </div>

    <div class="grid3">
      <section class="panel" id="identities-panel"><h2>Identities seen <span class="sub win"></span></h2><div class="bars" id="stat-identities"></div></section>
      <section class="panel"><h2>Busiest paths <span class="sub win"></span></h2><div class="bars" id="stat-paths"></div></section>
      <section class="panel"><h2>Denied paths <span class="sub win"></span></h2><div class="bars" id="stat-denied-paths"></div></section>
    </div>

    <div class="two">
      <section class="panel">
        <h2>Installed detectors <span class="sub" id="detector-count"></span></h2>
        <div class="detectors" id="stat-detector-list"></div>
      </section>
      <div class="stack">
        <section class="panel">
          <h2>Rules that fired <span class="sub win"></span></h2>
          <div class="bars" id="stat-rule-hits"></div>
        </section>
        <section class="panel">
          <h2>Bypassed <span class="sub">detection never ran</span></h2>
          <div class="bars" id="stat-bypassed"></div>
        </section>
      </div>
    </div>
  </div>

  <div id="view-policy" role="tabpanel" aria-labelledby="tab-policy" class="stack" hidden>
    <div class="two">
      <section class="panel" id="editor-panel">
        <h2>Rules <span class="sub" id="policy-mode"></span></h2>
        <div class="bar-actions">
          <div class="seg" id="editor-mode">
            <button id="mode-gui" aria-pressed="true">Editor</button>
            <button id="mode-json" aria-pressed="false">JSON</button>
          </div>
          <button id="policy-preview">Preview</button>
          <button id="policy-apply" class="primary" hidden>Apply</button>
          <button id="policy-revert">Revert</button>
          <span class="grow"></span>
          <button id="policy-import">Import…</button>
          <button id="policy-export">Export</button>
          <span class="dirty" id="policy-dirty" hidden>unsaved</span>
        </div>
        <div id="editor-gui">
          <div class="rulelist" id="rulelist"></div>
          <div class="bar-actions">
            <button id="rule-add">+ Add rule</button>
            <button id="rule-expand">Expand all</button>
            <span class="hint" id="policy-note"></span>
          </div>
        </div>
        <div class="editor" id="editor-json" hidden>
          <textarea id="policy-json" spellcheck="false" autocomplete="off" aria-label="Policy rules as JSON"></textarea>
        </div>
        <div class="editor"><div class="result" id="policy-result" hidden></div></div>
        <input type="file" id="policy-file" accept="application/json,.json" hidden>
      </section>

      <div class="stack">
        <section class="panel" id="guard-panel">
          <h2>Guard <span class="sub" id="guard-mode"></span></h2>
          <div id="stat-policy"></div>
          <div class="note" id="guard-note"></div>
        </section>
        <section class="panel" id="ranges-panel">
          <h2>Range sets <span class="sub" id="ranges-mode"></span></h2>
          <div id="ranges-body"></div>
          <div class="note" id="ranges-note"></div>
        </section>
        <section class="panel">
          <h2>Preview a shipped preset</h2>
          <div class="rules" id="preset-buttons"></div>
          <div class="note">Runs the preset against the requests still in the window and shows what would change. Nothing is applied.</div>
        </section>
        <section class="panel" id="changes-panel">
          <h2>Changes <span class="sub" id="change-count"></span></h2>
          <div id="stat-changes"></div>
          <div class="note">What was applied to this process at runtime, and by whom when the dashboard's
             <code>auth</code> could say. Bounded and in memory: the durable copy is the
             <code>policy-change</code>, <code>guard-change</code>, <code>range-change</code> and
             <code>actor-change</code> events.</div>
        </section>
        <section class="panel" id="notices-panel">
          <h2>Notices <span class="sub" id="notice-count"></span></h2>
          <div id="stat-notices"></div>
        </section>
      </div>
    </div>

    <div class="two">
      <section class="panel">
        <h2>Rules, in evaluation order</h2>
        <div class="rules" id="stat-rules"></div>
      </section>
      <section class="panel" id="robots-panel">
        <h2>robots.txt this policy implies</h2>
        <div class="editor"><pre class="code" id="robots-preview"></pre><div id="robots-notes"></div></div>
      </section>
    </div>
  </div>
</main>

<div class="toasts" id="toasts" aria-live="polite"></div>
`;

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>__TITLE__ · bot dashboard</title>
<style nonce="__NONCE__">
${DASHBOARD_CSS}
</style>
</head>
<body>
${DASHBOARD_MARKUP}
<script nonce="__NONCE__">
window.__BOOTSTRAP__ = JSON.parse(__BOOT_JSON__);
__SCRIPT__
</script>
</body>
</html>
`;
