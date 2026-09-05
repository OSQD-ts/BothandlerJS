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
  });

  const contact = options.contactHtml ?? "";

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
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${message}</p>
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

  function submit(solution) {
    say("Almost done…");
    fetch(config.verifyPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ challenge: config.challenge, solution: solution, ms: Date.now() - started })
    }).then(function (response) {
      if (!response.ok) { stop("The check could not be completed. Please reload the page to try again."); return; }
      say("Done. Loading the page…");
      window.location.reload();
    }).catch(function () {
      stop("The check could not be completed because the network request failed. Please reload the page.");
    });
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
function jsonForScript(value: { challenge: string; difficulty: number; verifyPath: string }): string {
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
