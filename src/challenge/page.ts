import { randomId } from "../internal/crypto.js";

export interface ChallengePageOptions {
  /** Signed challenge blob the client must solve and return. */
  challenge: string;
  /** Leading zero bits required. */
  difficulty: number;
  /** Where the solution is POSTed. */
  verifyPath: string;
  /** Shown as the page heading. Default "Checking your browser". */
  title?: string;
  /** Shown under the heading. Keep it short and non-accusatory. */
  message?: string;
  /** Where a person who cannot complete the check should turn. Strongly recommended. */
  contactHtml?: string;
  /** Page language for the `lang` attribute. Default "en". */
  lang?: string;
  /**
   * Ask for a deliberate gesture as well as the proof of work, and probe what the
   * browser can actually do while waiting for it.
   *
   * The control is a plain checkbox for a reason. It is the one interactive element that
   * every way of using a computer can operate — pointer, touch, the space bar, a screen
   * reader, switch access, voice control — so requiring it excludes far less than a
   * drag, a puzzle or anything needing visual acuity would.
   */
  interaction?: boolean;
  /**
   * Shape of this challenge's layout probe. Rendered into the markup and the stylesheet
   * so that answering it requires laying it out; see `probeShapeFor`.
   */
  probe?: { boxes: number; height: number };
}

export interface RenderedChallenge {
  html: string;
  /**
   * Nonce for the inline script. Put it in your CSP as `script-src 'nonce-…'`.
   * The action layer does this for you; it is exposed for hand-rolled responses.
   */
  scriptNonce: string;
}

/**
 * Renders the interstitial that carries the proof-of-work challenge.
 *
 * Design constraints, in the order they mattered:
 *
 * 1. **No external resources.** No CDN, no font, no image, no analytics. A page shown
 *    to a client under suspicion must not become a way to make that client fetch
 *    something else, and it has to work when the rest of your site is being shielded.
 * 2. **Accessible.** People using screen readers hit these pages, and a check they
 *    cannot perceive is indistinguishable from a broken site. The status is a live
 *    region, focus is managed, and the failure state gives a real way to get help.
 * 3. **Honest with the visitor.** No fake progress bar, no "verifying you are human"
 *    when what is actually being verified is that a JavaScript engine is present.
 * 4. **A visible way out.** `contactHtml` is not decoration. Anyone on a browser
 *    without WebCrypto, with JavaScript disabled, or on a device too slow to finish
 *    is a person your site has just locked out; they need somewhere to go.
 */
export function renderChallengePage(options: ChallengePageOptions): RenderedChallenge {
  const scriptNonce = randomId(12);
  const title = escapeHtml(options.title ?? "Checking your browser");
  const message = escapeHtml(options.message ?? "This takes a moment and happens once. Your browser is solving a small puzzle to show it can run scripts.");
  const lang = escapeHtml(options.lang ?? "en");

  const config = jsonForScript({
    challenge: options.challenge,
    difficulty: options.difficulty,
    verifyPath: options.verifyPath,
    interaction: options.interaction === true,
  });

  const contact = options.contactHtml ?? "";
  // Rendered server-side rather than built by the script: the count is not derivable by
  // the client, so there is nothing for it to compute — only something to measure.
  const probe = options.probe ?? { boxes: 4, height: 7 };

  // The gesture, and the elements the capability probes read. Both are omitted entirely
  // when the interaction challenge is off, so the plain interstitial is unchanged.
  const interactionBlock = options.interaction
    ? `<div class="check">
    <input type="checkbox" id="confirm" autocomplete="off" aria-describedby="confirm-hint">
    <div>
      <label for="confirm">I am a person</label>
      <!-- Associated with the input rather than left floating beside it: without
           aria-describedby a screen reader announces "I am a person, checkbox" and never
           reads the instruction. And the instruction says the space bar rather than "Tab,
           then Space", because the page moves focus here as soon as the puzzle finishes —
           so Tab would move it away again. -->
      <span class="hint" id="confirm-hint">Tick the box to continue, or press the space bar.</span>
    </div>
  </div>
  <span id="probe-css" aria-hidden="true"></span>
  <span id="probe-boxes" aria-hidden="true">${"<i></i>".repeat(probe.boxes)}</span>
  <span id="probe-hidden" aria-hidden="true"></span>
  <span class="probe-text" id="probe-a" aria-hidden="true">MMMMMMMMMM</span>
  <span class="probe-text" id="probe-b" aria-hidden="true" style="font-family:monospace">MMMMMMMMMM</span>`
    : "";

  // Only rendered when the interaction challenge is on, so the plain interstitial
  // carries none of it — no probes, no listeners, no rules to read back, nothing.
  const interactionStyles = options.interaction
    ? `  /* Tinted with the ink rather than mixed toward white. Mixing toward white lightens
     the surface in *both* themes, which in dark mode put muted text on a mid grey and
     failed contrast at 3.6:1. Tinting with --fg moves the surface the right way in each
     theme and leaves the hint readable in both. */
  .check { display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 14px 16px;
           border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--fg) 4%, transparent); }
  /* Load-bearing: the display rule above outranks the user agent's [hidden] style, so
     setting .hidden on this block does nothing without it — the control stays on screen
     after the page has already given up. */
  .check[hidden] { display: none; }
  .check input { width: 20px; height: 20px; flex: none; accent-color: var(--accent); cursor: pointer; }
  .check label { cursor: pointer; }
  .check .hint { display: block; font-size: 0.85rem; color: var(--muted); margin-top: 2px; }
  /* Read back by the first probe. A client that parsed the HTML but never built a CSSOM
     cannot report this value, because nothing ever computed it. */
  #probe-css { letter-spacing: 3px; }
  #probe-hidden { display: none; }
  /* The nonce-bound probe. Its height is the answer the server is asking for, so it is
     stated once here and read from src/challenge/interaction.ts on the other side. */
  #probe-boxes { position: absolute; left: -10000px; top: auto; width: 1px; }
  #probe-boxes i { display: block; height: ${probe.height}px; }
  .probe-text { position: absolute; left: -10000px; top: auto; white-space: pre; font-size: 32px; }`
    : "";

  const interactionScript = options.interaction ? String.raw`  // ---- the interaction challenge -------------------------------------------------
  //
  // Two jobs: watch what the pointer does on the way to the control, and find out what
  // this browser can actually do. Everything gathered here is a *claim* — the server
  // decides what any of it is worth, because a page that scored itself would just be
  // asked to report a good score. See src/challenge/interaction.ts.

  var box = document.getElementById("confirm");
  var path = [];
  var lastMove = null;
  var lastPointerType = "";
  var capabilities = {};
  var layoutHeight;

  // One clock for everything in here.
  //
  // This was two, and the bug that caused made the whole movement analysis dead code.
  // Pointer timestamps are DOMHighResTimeStamps measured from the time origin — about
  // 1500 by the time somebody clicks — and they were compared against Date.now(), which
  // is about 1.75e12. The difference is never under two seconds, so every activation
  // classified as a keyboard, the pointer branch never ran once, and a real 27-sample
  // mouse path was collected, posted and thrown away.
  function nowMs() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  function probe() {
    // Did a CSSOM parse the stylesheet and run the cascade? An HTTP client that read the
    // HTML has no answer to this, because nothing computed a value to read back.
    try {
      var el = document.getElementById("probe-css");
      capabilities.cssApplied = !!el && getComputedStyle(el).letterSpacing === "3px";
    } catch (error) { capabilities.cssApplied = false; }

    // Did layout run?
    try {
      var main = document.querySelector("main");
      capabilities.layout = !!main && main.getBoundingClientRect().width > 0;
    } catch (error) { capabilities.layout = false; }

    // Is display:none honoured, rather than merely parsed?
    try {
      var hidden = document.getElementById("probe-hidden");
      capabilities.hiddenIsHidden = !!hidden && hidden.getBoundingClientRect().width === 0;
    } catch (error) { capabilities.hiddenIsHidden = false; }

    // The nonce-bound probe: lay out a number of boxes derived from this challenge's
    // nonce and measure the result. Every other answer in this report is the same from
    // one challenge to the next and can therefore be captured once and replayed for
    // ever; this one cannot, because the question changes.
    try {
      var boxes = document.getElementById("probe-boxes");
      if (boxes) layoutHeight = Math.round(boxes.getBoundingClientRect().height * 100) / 100;
    } catch (error) { layoutHeight = undefined; }

    // Is there a font engine? Two identical strings in different families measure
    // differently only if something actually shaped the text.
    try {
      var a = document.getElementById("probe-a");
      var b = document.getElementById("probe-b");
      var wa = a ? a.getBoundingClientRect().width : 0;
      var wb = b ? b.getBoundingClientRect().width : 0;
      capabilities.fontMetrics = wa > 0 && wb > 0 && Math.abs(wa - wb) > 0.5;
    } catch (error) { capabilities.fontMetrics = false; }

    // Does a media query evaluate against a real viewport?
    try {
      capabilities.mediaQuery = !!window.matchMedia && window.matchMedia("(min-width: 1px)").matches === true;
    } catch (error) { capabilities.mediaQuery = false; }

    // Is there a frame loop? Two frames, a plausible gap apart.
    //
    // Deferred while the tab is hidden, because a hidden tab does not paint and
    // requestAnimationFrame does not fire in one. Probing anyway would report false for
    // somebody who opened the page in a background tab and come back to bite them when
    // they switched to it — and they cannot tick the box without switching to it, so
    // waiting for that moment costs nothing and removes the false negative.
    capabilities.animationFrame = false;
    function probeFrames() {
      try {
        if (!window.requestAnimationFrame) return;
        requestAnimationFrame(function (first) {
          requestAnimationFrame(function (second) {
            capabilities.animationFrame = second > first && second - first < 1000;
          });
        });
      } catch (error) { capabilities.animationFrame = false; }
    }
    if (document.hidden) {
      document.addEventListener("visibilitychange", function once() {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", once);
        probeFrames();
      });
    } else {
      probeFrames();
    }
  }

  function watch() {
    // Passive listeners: this must never delay a scroll or a tap.
    window.addEventListener("pointermove", function (event) {
      if (!event.isTrusted) return;
      lastPointerType = event.pointerType || "";
      var now = nowMs();
      if (lastMove !== null) {
        // A rolling window of the *most recent* samples, which is the opposite of what
        // this did first. Capping the array by refusing to push once full kept the first
        // 128 samples and threw away everything after — so for anyone who moved the
        // mouse while reading, the analysis measured their idle wandering and never saw
        // the approach to the control, which is the ballistic-then-corrective movement
        // the whole thing is built to recognise. It was exploitable in the obvious
        // direction too: emit plausible noise on load, then move however you like.
        if (path.length >= 128) path.shift();
        // Rounded to two places: enough to keep the sub-pixel deltas that pointer
        // acceleration and touch produce, without shipping a precise cursor trace.
        path.push([
          Math.round((event.clientX - lastMove.x) * 100) / 100,
          Math.round((event.clientY - lastMove.y) * 100) / 100,
          Math.max(0, Math.round(now - lastMove.t)),
        ]);
      }
      lastMove = { x: event.clientX, y: event.clientY, t: now };
    }, { passive: true });

    // The click event's detail property is how the platform itself distinguishes the
    // two: it is the click count for a pointer, and exactly 0 when a control is
    // activated from the keyboard.
    // A time-based guess was used here first and was wrong in both directions — a stray
    // pointermove at load made a keypress look like a mouse, and a tap, which emits
    // almost no pointermove, looked like one too.
    var activationVia = "keyboard";
    box.addEventListener("click", function (event) {
      if (event.detail === 0) { activationVia = "keyboard"; return; }
      activationVia = lastPointerType === "touch" || lastPointerType === "pen" ? "touch" : "pointer";
    });

    box.addEventListener("pointerdown", function (event) {
      if (event.isTrusted) lastPointerType = event.pointerType || "";
    }, { passive: true });

    box.addEventListener("change", function (event) {
      if (!box.checked) { activation = null; say("Tick the box to continue."); return; }
      activation = {
        trusted: event.isTrusted === true,
        // Set by the click handler above. A path is expected from a mouse and from
        // nothing else: touch produces almost no pointermove — one sample, frequently
        // none — so reporting a tap as a mouse would score zero for movement and quietly
        // grade every phone down to the weaker clearance.
        via: activationVia,
        msToActivate: Date.now() - started,
        path: path.slice(),
        capabilities: capabilities,
        layoutHeight: layoutHeight,
      };
      say(solved === null ? "Thank you. Finishing the check…" : "Thank you. Almost done…");
      if (solved !== null) submit(solved);
    });
  }` : "";

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --muted: #5b6270; --bg: #fbfbfc; --line: #e2e5ea; --accent: #2f6feb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8eaee; --muted: #98a0ae; --bg: #14161a; --line: #2a2e36; --accent: #6c9bff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 30rem; border: 1px solid var(--line); border-radius: 12px; padding: 28px; background: color-mix(in srgb, var(--bg) 92%, #fff); }
  h1 { margin: 0 0 10px; font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; color: var(--muted); }
  .status { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex: none; }
  .spinner[hidden] { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
  .fallback { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 0.9rem; color: var(--muted); }
  a { color: var(--accent); }
${interactionStyles}
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${message}</p>
  ${interactionBlock}
  <div class="status">
    <div class="spinner" id="spin" aria-hidden="true"></div>
    <span id="status" role="status" aria-live="polite">Starting…</span>
  </div>
  <noscript>
    <div class="fallback">
      This check needs JavaScript, which appears to be turned off. Enable it for this
      site and reload the page.
      ${contact}
    </div>
  </noscript>
  <div class="fallback" id="help" hidden>
    ${contact}
  </div>
</main>
<script nonce="${scriptNonce}">
(function () {
  "use strict";
  var config = ${config};
  var status = document.getElementById("status");
  var spinner = document.getElementById("spin");
  var help = document.getElementById("help");

  function say(text) { status.textContent = text; }
  function stop(text) {
    say(text);
    spinner.hidden = true;
    if (help) help.hidden = false;
    // Take the gesture away with it. Whatever went wrong, the check cannot be completed
    // now, and leaving a live checkbox on screen offers a way out that does not exist —
    // worst of all to somebody using a screen reader, who finds a control, activates it,
    // and is told nothing at all. Hiding it removes it from the accessibility tree too.
    var gesture = document.querySelector(".check");
    if (gesture) gesture.hidden = true;
  }

  if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
    stop("This browser cannot complete the check: it does not provide the Web Crypto API.");
    return;
  }

  var encoder = new TextEncoder();
  var started = Date.now();

  function leadingZeroBits(bytes) {
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i];
      if (byte === 0) { bits += 8; continue; }
      bits += Math.clz32(byte) - 24;
      break;
    }
    return bits;
  }

  var counter = 0;

  // Solved in slices with a yield between them. A tight loop would freeze the tab,
  // which on a slower device looks exactly like a crashed page.
  function slice() {
    var deadline = Date.now() + 60;
    var chain = Promise.resolve();

    function step() {
      if (Date.now() > deadline) {
        say("Working… " + counter.toLocaleString() + " attempts");
        setTimeout(slice, 0);
        return;
      }
      var current = counter++;
      chain = crypto.subtle.digest("SHA-256", encoder.encode(config.challenge_nonce + ":" + current)).then(function (digest) {
        if (leadingZeroBits(new Uint8Array(digest)) >= config.difficulty) { submit(String(current)); return; }
        step();
      });
    }
    step();
  }

  ${interactionScript}

  var solved = null;
  var activation = null;

  function submit(solution) {
    // Both halves have to be in. The proof of work usually finishes first, so this is
    // normally the page waiting for the person rather than the other way round.
    if (config.interaction && activation === null) {
      solved = solution;
      say("Ready. Tick the box below to continue.");
      spinner.hidden = true;
      if (box) box.focus();
      return;
    }
    say("Almost done…");
    fetch(config.verifyPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ challenge: config.challenge, solution: solution, ms: Date.now() - started, interaction: activation })
    }).then(function (response) {
      if (!response.ok) { stop("The check could not be completed. Please reload the page to try again."); return; }
      say("Done. Loading the page…");
      window.location.reload();
    }).catch(function () {
      stop("The check could not be completed because the network request failed. Please reload the page.");
    });
  }

  if (config.interaction && box) {
    probe();
    watch();
  }

  slice();
})();
</script>
</body>
</html>`;

  return { html, scriptNonce };
}

/**
 * Serialises the challenge for embedding in a `<script>` block.
 *
 * Two escapes, both load-bearing. A literal `</script>` inside a JSON string would
 * end the block early and turn the rest of the value into markup. And U+2028 /
 * U+2029 are perfectly legal inside a JSON string but are *line terminators* in
 * JavaScript, so an unescaped one silently breaks the literal it sits in.
 */
function jsonForScript(value: { challenge: string; difficulty: number; verifyPath: string; interaction: boolean }): string {
  // The nonce is lifted out for the solver loop; it is already inside the signed blob.
  const nonce = readNonce(value.challenge);
  const payload = { ...value, challenge_nonce: nonce };
  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function readNonce(challenge: string): string {
  try {
    const body = challenge.slice(0, challenge.lastIndexOf("."));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { nonce?: unknown };
    return typeof claims.nonce === "string" ? claims.nonce : "";
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
