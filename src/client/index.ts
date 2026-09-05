/**
 * The browser half.
 *
 * Everything here runs on the page, and everything it produces is **client-asserted**
 * — which is the single most important thing to hold on to when reading it. A page
 * script can report that `navigator.webdriver` is false; it cannot prove it, because
 * the automation framework driving the page can rewrite the property before your
 * script ever runs, in one line.
 *
 * So these signals are not proof of anything, in either direction. What they are good
 * at is catching the enormous middle of the distribution: automation that is not
 * trying to hide, which is most of it. Treat what comes back as `moderate` evidence
 * at best — the {@link clientSignalsDetector} does exactly that, and deliberately
 * gives you no way to make it stronger.
 *
 * This module is published separately (`@osqd/bothandlerjs/client`) so that a page can
 * embed the script without pulling the server engine into a browser bundle.
 */

export interface ClientSignals {
  /** `navigator.webdriver`. Standard, and removed by any framework that cares. */
  webdriver?: boolean;
  /** The browser reported an empty language list, which real browsers do not. */
  noLanguages?: boolean;
  /** Screen dimensions are zero or absent, typical of a headless environment. */
  zeroDimensions?: boolean;
  /** Client Hints platform disagrees with the User-Agent's platform. */
  inconsistentPlatform?: boolean;
  /** A trusted input event was observed. */
  interacted?: boolean;
  /** Milliseconds from load to the first trusted interaction. */
  msToInteraction?: number;
  /** Automation properties found on `window`, e.g. a CDP or driver hook. */
  automationGlobals?: string[];
}

export interface ClientScriptOptions {
  /** Where signals are POSTed. Your route; it should be cheap and rate-limited. */
  endpoint: string;
  /** CSP nonce for the inline script. Supply one if your policy needs it. */
  nonce?: string;
  /**
   * Wait for a trusted interaction before reporting, up to this many ms, so a single
   * request carries both the passive signals and the interaction result. Default 8000.
   */
  interactionWindowMs?: number;
}

/**
 * The script source, as a string.
 *
 * Deliberately dependency-free, defensive about every property it touches (a hardened
 * browser throws on several), and fire-and-forget — it uses `sendBeacon` where
 * available so that reporting never delays a navigation.
 */
export function clientScriptSource(options: ClientScriptOptions): string {
  const endpoint = JSON.stringify(options.endpoint);
  const windowMs = Math.max(0, options.interactionWindowMs ?? 8000);

  return `(function () {
  "use strict";
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  var nav = window.navigator || {};
  var started = Date.now();
  var sent = false;

  // Property *names* no ordinary browser defines. Membership is tested with \`in\`, so
  // every entry has to be non-standard — \`webdriver\` was on this list and is not:
  // \`navigator.webdriver\` is a standard property that exists, set to false, in every
  // current browser. Testing for its presence therefore reported an automation global
  // for every real visitor, which is the exact population this script exists to clear.
  // Its value is what matters, and \`signals.webdriver\` below reads it properly.
  var globals = [];
  var suspects = ["__webdriver_script_fn", "__selenium_unwrapped", "__playwright", "__puppeteer_evaluation_script__", "_phantom", "callPhantom", "__nightmare", "cdc_adoQpoasnfa76pfcZLmcfl_Array"];
  for (var i = 0; i < suspects.length; i++) {
    if (safe(function () { return suspects[i] in window || suspects[i] in nav; })) globals.push(suspects[i]);
  }

  // "Absent" and "zero" have to stay distinguishable, and \`|| 1\` did not keep them
  // apart: zero is falsy, so the sentinel meant to stand in for an unreadable value
  // replaced the exact value being tested for. Both of these could therefore never be
  // true — an empty language list and a zero-width screen, the two clearest marks of a
  // headless environment, reported the same as a normal browser. Undefined means we
  // could not look; a number means we did.
  var languageCount = safe(function () { return nav.languages ? nav.languages.length : undefined; });
  var screenWidth = safe(function () { return window.screen ? window.screen.width : undefined; });

  var signals = {
    webdriver: safe(function () { return nav.webdriver === true; }) === true,
    noLanguages: languageCount === 0,
    zeroDimensions: screenWidth === 0,
    inconsistentPlatform: false,
    interacted: false,
    automationGlobals: globals
  };

  var hinted = safe(function () { return nav.userAgentData && nav.userAgentData.platform; });
  var ua = safe(function () { return nav.userAgent; }) || "";
  if (hinted) {
    var lower = ua.toLowerCase();
    var expected = hinted.toLowerCase().replace(/\\s+/g, "");
    var agrees =
      (expected.indexOf("win") === 0 && lower.indexOf("windows") >= 0) ||
      (expected.indexOf("mac") === 0 && lower.indexOf("mac os") >= 0) ||
      (expected === "linux" && lower.indexOf("linux") >= 0) ||
      (expected === "android" && lower.indexOf("android") >= 0) ||
      (expected === "ios" && (lower.indexOf("iphone") >= 0 || lower.indexOf("ipad") >= 0)) ||
      (expected.indexOf("chrome") === 0 && lower.indexOf("cros") >= 0);
    signals.inconsistentPlatform = !agrees;
  }

  function send() {
    if (sent) return;
    sent = true;
    var body = JSON.stringify(signals);
    // sendBeacon survives the page being navigated away from, which is exactly when
    // a short visit reports. Falling back to fetch keepalive for older browsers.
    if (navigator.sendBeacon) {
      try { navigator.sendBeacon(${endpoint}, new Blob([body], { type: "application/json" })); return; } catch (e) { /* fall through */ }
    }
    try { fetch(${endpoint}, { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true, credentials: "same-origin" }); } catch (e) { /* best effort */ }
  }

  function onInteraction(event) {
    // isTrusted distinguishes real input from an event a script dispatched. It is
    // the single most informative bit on this page, and it is still forgeable by a
    // framework driving a real browser.
    if (!event || event.isTrusted !== true) return;
    signals.interacted = true;
    signals.msToInteraction = Date.now() - started;
    send();
  }

  var types = ["pointerdown", "keydown", "touchstart", "wheel"];
  for (var t = 0; t < types.length; t++) {
    window.addEventListener(types[t], onInteraction, { once: true, capture: true, passive: true });
  }

  setTimeout(send, ${windowMs});
  window.addEventListener("pagehide", send, { once: true });
})();`;
}

/** The script wrapped in a tag, ready to inline near the end of `<body>`. */
export function renderClientScript(options: ClientScriptOptions): string {
  const nonce = options.nonce !== undefined ? ` nonce="${options.nonce.replace(/[^A-Za-z0-9+/=_-]/g, "")}"` : "";
  return `<script${nonce}>${clientScriptSource(options)}</script>`;
}

/**
 * Validates a posted signal payload.
 *
 * Every field is client-supplied, so nothing is trusted and nothing is coerced —
 * anything of the wrong type is dropped rather than interpreted. Returns `undefined`
 * for a payload that is not a plausible signal object at all.
 */
export function parseClientSignals(payload: unknown): ClientSignals | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const input = payload as Record<string, unknown>;
  const signals: ClientSignals = {};

  for (const key of ["webdriver", "noLanguages", "zeroDimensions", "inconsistentPlatform", "interacted"] as const) {
    if (typeof input[key] === "boolean") signals[key] = input[key];
  }
  if (typeof input["msToInteraction"] === "number" && Number.isFinite(input["msToInteraction"]) && input["msToInteraction"] >= 0) {
    signals.msToInteraction = Math.min(input["msToInteraction"], 3_600_000);
  }
  if (Array.isArray(input["automationGlobals"])) {
    signals.automationGlobals = input["automationGlobals"].filter((entry): entry is string => typeof entry === "string").slice(0, 16).map((entry) => entry.slice(0, 64));
  }
  return Object.keys(signals).length > 0 ? signals : undefined;
}
