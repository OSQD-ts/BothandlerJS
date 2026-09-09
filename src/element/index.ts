/**
 * `<bot-dashboard>` — the operator dashboard as an element you drop into your own page.
 *
 * ```html
 * <bot-dashboard src="/_bots"></bot-dashboard>
 * <script type="module">
 *   import { defineBotDashboard } from "@osqd/bothandlerjs/element";
 *   defineBotDashboard();
 * </script>
 * ```
 *
 * The data still comes from a mounted handler — `createDashboardHandler(botHandler, {
 * basePath: "/_bots" })` — because there is nowhere else for it to come from. What the
 * element removes is having to build, style and route a page around it.
 *
 * ## What running it in your page costs you
 *
 * This renders into a shadow root inside your document, which is what makes it sit in
 * your layout rather than in a frame. The shadow root is a styling boundary and **not a
 * security boundary**: any script that can run on the host page can reach into it, read
 * every visitor address and verdict on screen, and call the dashboard's API with your
 * credentials. On the standalone page an injected script in your application could do
 * none of that.
 *
 * So mount it on a page that is already behind your admin authentication, and treat an
 * XSS on that page as equivalent to handing over the dashboard. If you would rather have
 * the isolation than the layout, serve the standalone page instead — it is the same
 * dashboard, and `createDashboardHandler` already returns it.
 */

import { cssEscape } from "../dashboard/client/css.js";
import { cellText, explainStatus, parseMount, resolveSections, shapeOf } from "./config.js";
import type { BotDashboardConfig, BotDashboardPanel, BotDashboardRows, BotDashboardTab, BotDashboardTabId, BotDashboardTheme } from "./config.js";
import { DASHBOARD_CSS, DASHBOARD_MARKUP } from "../dashboard/page.js";

/** One screen of the dashboard. */
export type { BotDashboardConfig, BotDashboardPanel, BotDashboardRows, BotDashboardTab, BotDashboardTabId, BotDashboardTheme };

/**
 * Most rows a panel may put on the page.
 *
 * A panel is a summary, and a source that returns everything it has should not be able to
 * lock up somebody's admin page while fifty thousand rows are laid out — which is exactly
 * what an unbounded version did when asked. Anything past this is dropped and said so, so
 * the number on screen is never quietly wrong.
 */
const MAX_PANEL_ROWS = 200;

const TAB_ELEMENT: Record<BotDashboardTabId, string> = {
  live: "tab-live",
  actors: "tab-actors",
  stats: "tab-stats",
  policy: "tab-policy",
};


const EXTRA_CSS = `
/* What the body element carries on the standalone page.
   A shadow root has no body, so without this nothing sets the base colour, background or
   type: every element inherited the *host page's* colour instead. On a white page that
   passed for correct; in dark mode it was near-black text on a near-black surface, which
   axe reported as a serious contrast failure and which is exactly the kind of thing this
   library is not supposed to ship. */
:host {
  display: block;
  background: var(--page);
  color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
:host([hidden]) { display: none; }
/* The page's own chrome assumes it owns the viewport. Inside somebody else's layout the
   element is the viewport, so the sticky header sticks to the element and the body
   metrics come from the host box. */
:host { position: relative; }
:host header { position: sticky; top: 0; }
.bd-extra { display: grid; gap: 10px; padding: 14px 15px; }
.bd-notice { font: 14px/1.5 system-ui, sans-serif; padding: 14px; margin: 0; color: var(--crit-text, #8a1c1c); }
.bd-extra .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.bd-extra .row b { font-weight: 600; font-variant-numeric: tabular-nums; }
.bd-extra .row span { color: var(--muted); font-size: 12px; }
:host([data-density="compact"]) tbody td,
:host([data-density="compact"]) thead th { padding-top: 5px; padding-bottom: 5px; }
:host([data-density="compact"]) .panel > h2 { padding-top: 8px; padding-bottom: 8px; }
`;

/**
 * The dashboard's rendered subtree, kept across mounts.
 *
 * An SPA route unmounts and remounts the element, and the first version refused the second
 * mount outright — "a bot dashboard is already running on this page" — which made the
 * element unusable in React, Vue or anything else with a router. The client is a module
 * graph that evaluates once and holds its own state, so it cannot simply be started again.
 *
 * Keeping the subtree and re-parenting it into the new shadow root solves both halves: the
 * client's element references stay valid because they are the same nodes, and the feed
 * history survives the navigation instead of starting empty. What changes on a remount is
 * the host element the theme hangs off, and the stylesheet, which belongs to the shadow
 * root rather than to the subtree.
 */
let container: HTMLElement | undefined;
let owner: BotDashboardElement | undefined;
/**
 * The theme most recently applied, remembered across mounts.
 *
 * A router builds a *new* element on the way back to a route, and that element carries no
 * configuration until the framework sets it — which for an attribute-driven or set-once
 * integration is never. Without this the dashboard came back unthemed: the tokens had been
 * set as inline properties on the previous host, which is gone.
 */
let lastTheme: BotDashboardTheme | undefined;

/**
 * Registers `<bot-dashboard>`. Safe to call more than once.
 *
 * @param name - element name, if `bot-dashboard` is taken.
 */
export function defineBotDashboard(name = "bot-dashboard"): void {
  if (typeof customElements === "undefined") return;
  const taken = customElements.get(name);
  if (taken !== undefined) {
    // Calling this twice is ordinary and stays silent — it is the documented way to be
    // safe about ordering. A name held by *something else* is a different situation
    // entirely: this call does nothing, every `<bot-dashboard>` on the page is the other
    // library's element, and nothing about the resulting blank space says so.
    if (taken !== BotDashboardElement && !(taken.prototype instanceof BotDashboardElement) && !clashed.has(name)) {
      clashed.add(name);
      console.warn(`bot-dashboard: <${name}> is already registered on this page by something else, so this did nothing and your <${name}> elements are not this dashboard. Register it under a name of your own instead: defineBotDashboard("ops-dashboard").`);
    }
    return;
  }
  // A constructor may be registered once per registry, so a second name cannot reuse this
  // class — `customElements.define` throws NotSupportedError, uncaught, from inside a
  // function whose whole job is to register a name. A fresh subclass per name is what the
  // platform wants, and it costs nothing: the behaviour is inherited whole.
  //
  // Only one dashboard runs at a time whatever it is called; that is enforced separately,
  // in `boot`.
  customElements.define(name, registered ? class extends BotDashboardElement {} : BotDashboardElement);
  registered = true;
}

/** Whether the base class has been handed to the registry yet. See {@link defineBotDashboard}. */
let registered = false;

/** Names already reported as taken, so calling `defineBotDashboard` twice says it once. */
const clashed = new Set<string>();

/**
 * `HTMLElement`, or a stand-in where there is no DOM.
 *
 * `class X extends HTMLElement` is evaluated when the module is *loaded*, not when the
 * element is used — so on a server, where there is no `HTMLElement`, merely importing this
 * file threw `ReferenceError` before a line of anyone's code ran. That is not an exotic
 * case: it is what every framework with server rendering does with a top-level
 * `import { defineBotDashboard } from "@osqd/bothandlerjs/element"`, which is exactly the
 * line the documentation tells people to write.
 *
 * `defineBotDashboard` already declines to do anything without a `customElements`
 * registry, so the intent was there; the class declaration simply ran first. With this the
 * module imports anywhere, and does nothing at all until it is in a browser.
 */
const ElementBase: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

export class BotDashboardElement extends ElementBase {
  private settings: BotDashboardConfig = {};
  private booted = false;
  /**
   * Booted *and* finished drawing. Distinct from `booted`, which is set on the way in:
   * `connectedCallback` replays a config assigned before the upgrade through the setter,
   * and at that moment `booted` is already true — so a warning keyed on it fired on a
   * perfectly ordinary mount, complaining that the config had changed when what had
   * happened was that it had arrived.
   */
  private rendered = false;

  /**
   * Set before the element is attached, or pass the same things as attributes.
   *
   * An accessor rather than a field, and the difference is load-bearing. A page that
   * writes `el.config = {...}` before the element is defined puts an *own property* on
   * the instance, and a class field initialiser then runs at upgrade and overwrites it —
   * so the configuration silently disappears and the dashboard renders its defaults. The
   * accessor plus the upgrade dance in `connectedCallback` is the documented way round
   * it, and the order it protects (write the config, then define the element) is the
   * natural one to write.
   */
  get config(): BotDashboardConfig {
    return this.settings;
  }

  set config(value: BotDashboardConfig) {
    const before = this.rendered && this.isConnected ? shapeOf(this.settings) : undefined;
    this.settings = value ?? {};
    // Applied immediately when the element is already running, so a framework that sets
    // its props after mount — which most of them do on a re-render — changes the theme
    // rather than being quietly ignored.
    if (this.booted && this.isConnected) {
      this.applyTheme();
      // `tabs` and `panels` are settled at boot, and until now changing them did nothing
      // at all — no effect and no word about it, which is the failure `src` a few lines
      // down already refuses to make. Compared by shape rather than by identity, because
      // a framework hands over a freshly built object on every render and warning about
      // that would be noise nobody could act on.
      if (before !== undefined && shapeOf(this.settings) !== before) {
        console.warn("bot-dashboard: `tabs` and `panels` are read once, when the element first mounts. Changing them afterwards has no effect — remount the element instead. (`theme` does update live.)");
      }
    }
  }
  private timers: number[] = [];
  /** Custom properties this element put on itself, so it can take them off again. */
  private appliedTokens = new Set<string>();
  private warned = new Set<string>();

  static get observedAttributes(): string[] {
    return ["src", "scheme", "density"];
  }

  connectedCallback(): void {
    if (this.booted) return;
    this.booted = true;
    // Reclaim anything assigned before the upgrade: delete the own property so the write
    // below reaches the accessor rather than sitting in front of it for ever.
    if (Object.prototype.hasOwnProperty.call(this, "config")) {
      const preset = (this as unknown as { config: BotDashboardConfig }).config;
      // The own property has to be removed, not emptied: assigning undefined leaves it in
      // place, shadowing the accessor on the prototype for the life of the element, and
      // the configuration never arrives. `Reflect.deleteProperty` rather than `delete`
      // says the same thing without tripping a lint rule aimed at hot loops; this runs
      // once per element.
      Reflect.deleteProperty(this, "config");
      this.config = preset;
    }
    void this.boot();
  }

  disconnectedCallback(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    // The subtree stays alive and detached, ready to be re-parented. Releasing ownership
    // is what lets a later element — the same one after a route change, or a different
    // one — pick it up.
    if (owner === this) owner = undefined;
    // And the stream goes with it. Left open it holds a server connection and keeps
    // drawing into a tree nobody can see, for as long as the page lives. Reconnecting
    // resumes from the last id seen, so the cost of a route change is a reconnect.
    void import("../dashboard/client/stream.js").then((stream) => {
      if (!this.isConnected) stream.suspendStream();
    });
  }

  attributeChangedCallback(attribute: string, previous: string | null, value: string | null): void {
    // Through the same two checks as the config path, so an attribute cannot set a value
    // the config would have refused.
    if (attribute === "scheme") this.applyScheme(value);
    if (attribute === "density") this.applyDensity(value);
    // `src` decides where the client fetches from, and the client reads it once as it
    // loads. Changing it later does nothing, and doing nothing quietly is how somebody
    // spends an afternoon on it.
    if (attribute === "src" && previous !== null && previous !== value && this.booted) {
      console.warn("bot-dashboard: `src` is read once, when the element first mounts. Changing it afterwards has no effect — replace the element instead.");
    }
  }

  /**
   * Give up on this attempt without giving up on the element.
   *
   * Every way a boot can end early — it lost the one-at-a-time race, its `src` is
   * cross-origin, its handler did not answer, it was unmounted mid-flight — is about this
   * moment rather than about this element, and all four are things a remount can fix: the
   * other dashboard has gone, the attribute was corrected, the server finished starting.
   * Releasing ownership without clearing `booted` was the bug: `connectedCallback` returns
   * early on a latched `booted`, so the element stayed dead for the life of the instance
   * and a router that remounts it drew a stale error over a handler that now works.
   */
  private standDown(): void {
    if (owner === this) owner = undefined;
    this.booted = false;
    this.rendered = false;
  }

  /**
   * Where the handler is mounted, from `config.src` or the attribute.
   *
   * A trailing slash is dropped, and so are a query string and a fragment — the element
   * appends `/api/bootstrap` to this, so anything after the path cannot survive that
   * concatenation and never could. Left in, `src="/_bots?token=x"` failed with "it
   * answered text/html — is createDashboardHandler mounted at /_bots?token=x?", which
   * sends somebody to check the one thing that was right.
   */
  private mountPath(): string {
    const { base, warning } = parseMount(this.config.src ?? this.getAttribute("src") ?? "");
    if (warning !== undefined) this.warnOnce(`bot-dashboard: ${warning}`);
    return base;
  }

  private async boot(): Promise<void> {
    const base = this.mountPath();
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    // A retry after a refusal or a failed boot: drop the message from that attempt, or the
    // dashboard renders underneath a line that is no longer true.
    //
    // Direct children only. The same class marks a panel's own "could not load" message,
    // and on a remount the built tree is still hanging in this shadow root — so a plain
    // `querySelectorAll(".bd-notice")` reached inside the panels and wiped those too. They
    // came back on the next repaint, which is why it looked harmless; it was still this
    // function deleting other code's output.
    //
    // Walked rather than selected, because `:scope > .bd-notice` matches nothing here: the
    // scoping root is a shadow root, `:scope` only matches an element, and the tidier
    // selector silently removed nothing at all.
    for (const child of Array.from(shadow.children)) {
      if (child.classList.contains("bd-notice")) child.remove();
    }

    // Still only one at a time. The client is a module graph with its own state, and two
    // live instances would share it — two feeds writing to one store, and the second
    // element silently drawing the first one's traffic. But *sequentially* is fine, and
    // is what a router does, so the test is whether one is currently connected rather
    // than whether one has ever been.
    if (owner !== undefined && owner !== this && owner.isConnected) {
      shadow.append(notice("A bot dashboard is already running on this page. Only one can be."));
      this.standDown();
      return;
    }
    owner = this;

    // A remount: re-parent what is already built and rendered, and re-point the theme.
    if (container !== undefined) {
      const dom = await import("../dashboard/client/dom.js");
      dom.setThemeHost(this);
      this.applyTheme();
      adoptStyles(shadow);
      shadow.append(container);
      this.renderPanels(container);
      // Pick the feed back up where it was left.
      const stream = await import("../dashboard/client/stream.js");
      stream.connectStream();
      this.rendered = true;
      this.dispatchEvent(new CustomEvent("bot-dashboard-ready", { bubbles: true }));
      return;
    }

    // A cross-origin `src` cannot work and should say why rather than failing as a bare
    // "Failed to fetch". The dashboard deliberately sends no Access-Control-Allow-Origin —
    // that is what stops another site reading your traffic through a logged-in browser —
    // so it is same-origin only, and pointing at another origin is a configuration
    // mistake rather than something to retry.
    if (base !== "" && /^https?:\/\//i.test(base)) {
      try {
        if (new URL(base).origin !== location.origin) {
          const why = `src points at ${new URL(base).origin}, which is not this page's origin. The dashboard is same-origin only: it sends no CORS headers, which is what stops another site reading your traffic. Mount it under this origin and use a path, e.g. src="/_bots".`;
          shadow.append(notice(`The bot dashboard could not start: ${why}`));
          console.error("bot-dashboard:", why);
          this.standDown();
          return;
        }
      } catch {
        /* an unparseable src falls through to the fetch, which reports it. */
      }
    }

    let boot: Record<string, unknown>;
    try {
      const response = await fetch(`${base}/api/bootstrap`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(explainStatus(response.status, base));
      // Checked before parsing, because the failure it catches is the common one and the
      // parser's account of it is useless: with no `src` the element asks its own origin,
      // is handed the host page's HTML, and reports "Unexpected token '<'" to a developer
      // whose actual mistake was forgetting an attribute.
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("json")) {
        throw new Error(
          base === ""
            ? "no `src` was given, so it asked this page's own origin and got HTML back. Point `src` at where createDashboardHandler is mounted, e.g. src=\"/_bots\""
            : `it answered ${type || "no content type"} rather than JSON. Is createDashboardHandler mounted at ${base}?`,
        );
      }
      boot = (await response.json()) as Record<string, unknown>;
      // Removed while that was in flight — a route change during the round trip. Ownership
      // was already handed back by `disconnectedCallback`, and somebody else may hold it
      // by now, so building into a detached tree here would be a second client racing the
      // live one for the same module state.
      if (!this.isConnected) {
        this.standDown();
        return;
      }
    } catch (error) {
      // A dashboard that cannot reach its handler should say so where somebody will see
      // it, rather than rendering an empty shell that looks like no traffic.
      const why = String(error instanceof Error ? error.message : error);
      shadow.append(notice(`The bot dashboard could not start: ${why}`));
      // Also to the console, because the element may be somewhere nobody is looking and
      // this is always a configuration mistake rather than a condition.
      console.error("bot-dashboard:", why);
      this.standDown();
      return;
    }

    // The mount path the element was given wins over whatever the server thinks it is:
    // the element is the thing that knows where it is pointing.
    boot["base"] = base;
    // Which screens survive the server's answer, `hide` and `tabs` — worked out in
    // `config.ts`, which has no document in it and can therefore be tested directly.
    const { sections, warnings } = resolveSections(boot["sections"] as Record<string, boolean>, this.config);
    for (const warning of warnings) this.warnOnce(`bot-dashboard: ${warning}`);
    boot["sections"] = sections;

    adoptStyles(shadow);

    const frame = document.createElement("div");
    frame.className = "bd-root";
    // The markup is this package's own, built from a template literal in `page.ts` and
    // containing no interpolation of anything a request supplied. It is the one place the
    // no-innerHTML rule does not apply, and a test asserts that rather than trusting it.
    //
    // The one placeholder it carries is the title, which the standalone renderer
    // substitutes and this has to as well — the first version did not, and the header
    // read "__TITLE__" to anyone who looked at it.
    frame.innerHTML = DASHBOARD_MARKUP;
    shadow.append(frame);
    const title = typeof boot["title"] === "string" ? boot["title"] : "bothandlerjs";

    // The page's own <main> is a landmark, and a landmark inside somebody else's page that
    // already has one is two mains: a screen reader user gets two "main" landmarks to
    // choose between, and axe reports landmark-no-duplicate-main and landmark-unique.
    //
    // Replaced rather than re-roled. Setting role="region" on a <main> silences those two
    // and earns aria-allowed-role instead, because <main> permits no role but its own — so
    // the honest fix is to not be a <main>. The class carries the layout, so swapping the
    // tag changes nothing visually.
    const main = frame.querySelector("main");
    if (main !== null) {
      // Swapped rather than re-roled, because <main> permits no role but its own —
      // setting role="region" silences the duplicate-landmark rules and earns
      // aria-allowed-role instead. Its class carries the layout, so the tag is all that
      // changes.
      const region = document.createElement("div");
      region.className = main.className;
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", `${title} bot dashboard`);
      while (main.firstChild !== null) region.append(main.firstChild);
      main.replaceWith(region);
    }

    // The <header> is a banner landmark for the same reason, and a page may have one
    // banner. Re-roled rather than swapped, because <header> does permit role="none" and
    // because its styling is by element rather than by class — a div here would lose it.
    // `none` drops the element's own semantics and leaves its children where they are.
    frame.querySelector("header")?.setAttribute("role", "none");
    for (const node of Array.from(frame.querySelectorAll("*"))) {
      for (const child of Array.from(node.childNodes)) {
        // textContent, so a title containing markup is a title containing markup.
        if (child.nodeType === 3 && child.nodeValue?.includes("__TITLE__") === true) {
          child.nodeValue = child.nodeValue.replace(/__TITLE__/g, title);
        }
      }
    }

    this.applyTheme();

    // Order matters. `setRoot` has to run before the rest of the client evaluates, since
    // its modules resolve their elements as they initialise — so the dom module is
    // imported and pointed at the shadow root first, and only then the entry.
    container = frame;
    const dom = await import("../dashboard/client/dom.js");
    // The subtree rather than the shadow root, so a remount can carry it to a new one.
    dom.setRoot(frame, this);
    // Handed over explicitly rather than left on the global for the client to find. The
    // global is still set, because the served page uses it and anything reading it should
    // see the truth — but this call is what the client actually reads, and it works
    // however early some other path happened to evaluate that module. See `applyBoot`.
    (globalThis as unknown as { __BOOTSTRAP__?: unknown }).__BOOTSTRAP__ = boot;
    const bootModule = await import("../dashboard/client/boot.js");
    bootModule.applyBoot(boot as unknown as Parameters<typeof bootModule.applyBoot>[0]);

    await import("../dashboard/client/index.js");
    // After the client, because it draws the strip from the boot object and would undo a
    // reorder applied before it ran.
    this.relabelTabs(shadow);
    this.renderPanels(frame);

    warnIfFramed();

    this.rendered = true;
    this.dispatchEvent(new CustomEvent("bot-dashboard-ready", { bubbles: true }));
  }

  private applyTheme(): void {
    const theme = this.config.theme ?? lastTheme ?? {};
    if (this.config.theme !== undefined) lastTheme = this.config.theme;
    this.applyScheme(theme.scheme ?? this.getAttribute("scheme"));
    this.applyDensity(theme.density ?? this.getAttribute("density"));

    const next = new Set<string>();
    for (const [token, value] of Object.entries(theme.tokens ?? {})) {
      const name = token.startsWith("--") ? token : `--${token}`;
      next.add(name);
      this.style.setProperty(name, value);
    }
    // A token dropped from the config has to be dropped from the element, or a theme
    // switch leaves the colours it stopped asking for painted on for ever. Removed by
    // name, one at a time, rather than by clearing the style attribute: the client keeps
    // its own measurements there — `--header-h` among them — and clearing it would take
    // the sticky header's layout with it.
    for (const name of this.appliedTokens) {
      if (!next.has(name)) this.style.removeProperty(name);
    }
    this.appliedTokens = next;
  }

  /**
   * `scheme` and `density` take two values each, and until now anything else was accepted
   * in silence — a mis-typed `scheme` did nothing, and a mis-typed `density` was written
   * onto the element as `data-density="cozy"`, matching no rule and looking, from the
   * outside, exactly like a dashboard that ignores its configuration.
   *
   * Warned once per bad value per element, because `applyTheme` runs on every re-render
   * and a typo that repeats a hundred times is a typo the console has stopped conveying.
   */
  private applyScheme(value: string | null | undefined): void {
    if (value === null || value === undefined) return;
    if (value === "light" || value === "dark") {
      this.setAttribute("data-theme", value);
      return;
    }
    this.warnOnce(`bot-dashboard: scheme "${value}" is not "light" or "dark", so it was ignored. Leave it unset to follow the viewer's own setting.`);
  }

  private applyDensity(value: string | null | undefined): void {
    if (value === null || value === undefined) return;
    if (value === "comfortable" || value === "compact") {
      this.setAttribute("data-density", value);
      return;
    }
    this.warnOnce(`bot-dashboard: density "${value}" is not "comfortable" or "compact", so it was ignored.`);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.warn(message);
  }

  /**
   * Reorders and relabels the strip the client has just drawn.
   *
   * Only the tabs that survived: which screens *exist* was settled in the boot object
   * before the client ran, because the client builds its list from there and looks each
   * one up by id — deleting an element here instead crashed it with "no element
   * #tab-actors", which is what this comment is standing in for.
   */
  private relabelTabs(shadow: ShadowRoot): void {
    const wanted = this.config.tabs;
    if (wanted === undefined || wanted.length === 0) return;
    const strip = shadow.querySelector(".tabs");
    if (strip === null) return;

    for (const tab of wanted) {
      const node = shadow.querySelector(`#${TAB_ELEMENT[tab.id]}`);
      if (node === null) continue;
      if (tab.label !== undefined) node.textContent = tab.label;
      // Appending a node already in the strip moves it, which is the reorder.
      strip.append(node);
    }
  }

  private renderPanels(within: ParentNode): void {
    const panels = this.config.panels ?? [];

    // The rendered tree outlives the element that built it — it is reused across a remount
    // and, on a route change, adopted by a *different* element with a different config. So
    // a panel that this config does not ask for has to go, or the new dashboard shows the
    // old one's panels alongside its own, frozen, because the timer that fed them was
    // cleared when their element was disconnected. Keyed on screen as well as id, so a
    // panel moved to another screen leaves rather than being drawn in both.
    const wanted = new Set(panels.map((panel) => `${panel.id}@${panel.screen}`));
    for (const section of Array.from(within.querySelectorAll("[data-bd-panel]"))) {
      const key = `${section.getAttribute("data-bd-panel")}@${section.getAttribute("data-bd-screen")}`;
      if (!wanted.has(key)) section.remove();
    }

    const drawn = new Set<string>();
    for (const panel of panels) {
      // Two panels under one id land on one section: the first builds it, the second finds
      // it and paints over it, and then both refresh timers write into the same body,
      // which flickers between two sources every second. The section keeps the first
      // panel's heading while showing the second one's rows, so the screen actively
      // misdescribes itself.
      const key = `${panel.id}@${panel.screen}`;
      if (drawn.has(key)) {
        this.warnOnce(`bot-dashboard: two panels share the id "${panel.id}" on screen "${panel.screen}". Ids identify a panel, so the second was ignored — give them different ids.`);
        continue;
      }
      drawn.add(key);

      // Escaped, because `screen` and `id` come from whoever wrote the config and a
      // selector built by interpolation is a parser waiting to be handed something it
      // cannot read. An id containing a quote threw `SyntaxError` out of `querySelector`
      // — from here, outside the per-paint try below — which took down the whole loop
      // before the first panel was built, left `bot-dashboard-ready` undispatched, and
      // reported itself as a complaint about a selector nobody wrote.
      const host = within.querySelector(`#view-${cssEscape(panel.screen)}`);
      if (host === null) {
        // Silence here means a panel that simply never appears, and a developer reading
        // their own config for an hour. `src` gets the same treatment a few lines up.
        // The list is read off the rendered markup rather than kept alongside it, so it
        // stays right when a screen is added and cannot drift into naming one that a
        // `tabs` or `hide` setting has already removed.
        const known = Array.from(within.querySelectorAll("[id^='view-']"))
          .map((node) => node.id.slice("view-".length))
          .join(", ");
        console.warn(`bot-dashboard: panel "${panel.id}" asks for screen "${panel.screen}", which this dashboard does not have. It has: ${known}.`);
        continue;
      }

      // A remount runs this against a subtree that already has the panels, so the section
      // is reused rather than rebuilt — but the timer below is *not*, because
      // `disconnectedCallback` cleared it. Skipping the whole loop here left a refreshing
      // panel frozen on whatever it last drew after the first route change.
      const existing = host.querySelector(`[data-bd-panel="${cssEscape(panel.id)}"]`);
      let body: HTMLElement;
      if (existing !== null) {
        body = existing.querySelector(".bd-extra") as HTMLElement;
      } else {
        const section = document.createElement("section");
        section.className = "panel";
        section.setAttribute("data-bd-panel", panel.id);
        section.setAttribute("data-bd-screen", panel.screen);
        const heading = document.createElement("h2");
        heading.textContent = panel.title;
        body = document.createElement("div");
        body.className = "bd-extra";
        section.append(heading, body);
        host.append(section);
      }

      const paint = async (): Promise<void> => {
        try {
          const data = typeof panel.source === "string"
            ? ((await (await fetch(panel.source, { credentials: "same-origin" })).json()) as BotDashboardRows)
            : await panel.source();
          while (body.firstChild) body.removeChild(body.firstChild);
          // Checked rather than assumed, because a source is somebody else's endpoint and
          // the failures are not hypothetical: `{ rows: "nope" }` is *iterable*, so
          // without this it rendered one row per character, each reading "undefined".
          if (!Array.isArray(data?.rows)) {
            body.append(notice(`${panel.title} returned no rows.`));
            return;
          }
          const all = data.rows;
          for (const row of all.slice(0, MAX_PANEL_ROWS)) {
            // A row with nothing to say is skipped rather than drawn as "undefined".
            if (typeof row !== "object" || row === null || row.label === undefined || row.value === undefined) continue;
            const line = document.createElement("div");
            line.className = "row";
            const label = document.createElement("span");
            label.textContent = cellText(row.label);
            const value = document.createElement("b");
            // textContent throughout. Whatever your endpoint returns is somebody's data,
            // and this file will not turn it into markup.
            value.textContent = cellText(row.value);
            line.append(label, value);
            if (row.note !== undefined) {
              const note = document.createElement("span");
              note.textContent = cellText(row.note);
              line.append(note);
            }
            body.append(line);
          }
          if (all.length > MAX_PANEL_ROWS) {
            const more = document.createElement("div");
            more.className = "row";
            const label = document.createElement("span");
            label.textContent = `${all.length - MAX_PANEL_ROWS} more not shown`;
            more.append(label);
            body.append(more);
          }
        } catch {
          while (body.firstChild) body.removeChild(body.firstChild);
          body.append(notice(`Could not load ${panel.title}.`));
        }
      };

      void paint();
      if (panel.refreshMs !== undefined && panel.refreshMs > 0) {
        this.timers.push(setInterval(paint, Math.max(1000, panel.refreshMs)) as unknown as number);
      }
    }
  }
}

/**
 * The stylesheet, built once and adopted by every shadow root that needs it.
 *
 * A constructable stylesheet rather than a `<style>` element, and the reason is Content
 * Security Policy. An injected `<style>` is inline style, so a host page carrying
 * `style-src 'self'` — which any admin page worth mounting this on does — blocks it, and
 * the dashboard renders with no colours, no radii and no layout at all. A stylesheet built
 * by script that has already satisfied `script-src` is not inline style and is not
 * blocked.
 *
 * It is also the cheaper answer: one parse of forty kilobytes of CSS shared by every
 * mount, rather than one per mount.
 */
let sheet: CSSStyleSheet | undefined;

function adoptStyles(shadow: ShadowRoot): void {
  if (typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype && "adoptedStyleSheets" in shadow) {
    if (sheet === undefined) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(`${DASHBOARD_CSS}\n${EXTRA_CSS}`);
    }
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    return;
  }
  // Older engines without constructable stylesheets. Blocked by a strict style-src, which
  // is the trade those browsers get rather than no dashboard at all.
  const style = document.createElement("style");
  style.textContent = `${DASHBOARD_CSS}\n${EXTRA_CSS}`;
  shadow.append(style);
}


/**
 * What of a config actually decides the rendered screens: which tabs, and which panels
 * where. Deliberately not the panel `source` functions — a framework rebuilds those
 * closures on every render, and a comparison that counted them would report a change on
 * every render regardless of whether anything meaningful differed.
 */

let framingWarned = false;

/**
 * The one protection that does not survive being embedded.
 *
 * The standalone dashboard is served by this package and its response carries
 * `frame-ancestors 'none'`, so a page on another origin cannot frame it and trick an
 * operator into clicking a control they cannot see. The element renders into a document
 * this package does not serve and cannot set a header on — so whether the same attack
 * works is decided by the host page's own headers, and the failure mode is silent.
 *
 * A warning rather than a refusal: an admin app framing its own pages is ordinary and
 * legitimate, which is why the check is specifically for a *cross-origin* ancestor —
 * reading `top.location` throws for one and reads fine for one of our own — and why the
 * decision to render anyway is not this element's to make.
 */
function warnIfFramed(): void {
  if (framingWarned) return;
  if (globalThis.top === globalThis.self) return;
  try {
    void (globalThis.top as Window).location.origin;
    return;
  } catch {
    framingWarned = true;
    console.warn(
      "bot-dashboard: this page is framed by another origin, and a framed dashboard can be clickjacked — an operator clicks a control they cannot see. The standalone page refuses framing with `frame-ancestors 'none'`; a page you serve yourself has to send that header itself, or `X-Frame-Options: DENY`.",
    );
  }
}


function notice(text: string): HTMLElement {
  // A class rather than `style.cssText`. Writing the style attribute is inline style, and
  // a host page carrying `style-src 'self'` blocks it — so the one element whose whole job
  // is to explain a failure would have appeared unstyled, in the situation where somebody
  // most needs to notice it.
  const node = document.createElement("p");
  node.className = "bd-notice";
  node.textContent = text;
  return node;
}


declare global {
  interface HTMLElementTagNameMap {
    "bot-dashboard": BotDashboardElement;
  }
}
