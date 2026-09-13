#!/usr/bin/env tsx
/**
 * The dashboard as `<bot-dashboard>`, inside somebody else's page.
 *
 *   npm run demo:embedded
 *
 *   :9675  an "admin panel" of our own, with the dashboard embedded in it
 *
 * The standalone dashboard is a page the library serves. This is the other half of the
 * story: the same dashboard as a custom element you drop into an admin panel you already
 * have, so it sits inside your own chrome, your own navigation and your own
 * authentication rather than beside them on a second port.
 *
 * ## Two things this demo is built around, because both are easy to get wrong
 *
 * **It must be same-origin.** The dashboard sends no CORS headers, on purpose, and the
 * element refuses a `src` pointing at another origin — so embedding it is not a matter of
 * pointing at the standalone dashboard on :9674. The handler is *mounted into this
 * server*, under `/_bots`, and the element is pointed at that path. That is the whole
 * integration, and it is why `createDashboardHandler` exists alongside `serveDashboard`.
 *
 * **This page is not behind the bot handler.** Nothing here is assessed. Watching the
 * dashboard must never show up in the dashboard, and a challenge served to the demo site
 * must never lock you out of the tool you are reading about it with. Mounting the element
 * does not change that rule — it moves the page, not the boundary.
 *
 * And the thing the element's own documentation says in as many words: a shadow root is a
 * styling boundary, **not a security boundary**. Any script that can run on this page can
 * reach into the dashboard, read every address and verdict on it, and call its API with
 * your credentials. A page hosting this belongs behind the same authentication as the
 * dashboard itself.
 */
import { createServer } from "node:http";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BotHandler, createDashboardHandler } from "../src/index.js";
import { CORPUS } from "../src/corpus/index.js";
import { createFacts } from "../src/index.js";

const PORT = Number(process.env["ADMIN_PORT"] ?? 9675);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A handler with something to show.
 *
 * The element is the subject here, not detection, so rather than wait for a simulator the
 * demo replays the traffic corpus through a real handler — real User-Agent strings, real
 * header sets in the order real clients send them. The feed has a few hundred assessed
 * requests in it the moment the page opens, which is what makes the paging, the window
 * controls and the counts worth looking at.
 */
const detector = new BotHandler({ preset: "protect-content", metrics: true });

async function seed(): Promise<number> {
  let count = 0;
  // Spread backwards over the last few hours so the window controls and the retention
  // choices have something to bite on. A feed where everything arrived in the same second
  // cannot demonstrate either.
  const now = Date.now();
  const span = 6 * 60 * 60_000;
  const cases = CORPUS.slice(0, 400);
  for (const [index, entry] of cases.entries()) {
    const first = entry.requests[0];
    if (first === undefined) continue;
    // The corpus keeps headers as ordered pairs rather than as an object, because header
    // order is itself a fingerprint and an object literal's key order is too easy to
    // disturb. `createFacts` takes both, so the order is preserved by passing it through.
    const headers: Record<string, string> = { host: "shop.example" };
    for (const [name, value] of first.headers) headers[name] = value;
    await detector.handle(
      createFacts({
        method: first.method ?? "GET",
        url: first.path ?? "/",
        headers,
        rawHeaders: first.headers.map(([name]) => name),
        ip: first.ip ?? `203.0.113.${index % 254}`,
        timestamp: now - span + Math.floor((index / cases.length) * span),
      }),
    );
    count++;
  }
  return count;
}

/** The element, bundled on demand so `npm run demo:embedded` needs no build step first. */
async function elementBundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "src", "element", "index.ts")],
    bundle: true,
    format: "esm",
    target: ["es2022"],
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Acme — admin</title>
  <style>
    :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
    header strong { font-size: 16px; letter-spacing: -0.01em; }
    nav { display: flex; gap: 4px; margin-left: auto; }
    nav a { padding: 6px 10px; border-radius: 6px; text-decoration: none; color: inherit; opacity: 0.65; font-size: 14px; }
    nav a[aria-current] { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }
    main { padding: 20px; max-width: 1400px; margin-inline: auto; }
    h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.015em; }
    .lede { margin: 0 0 20px; opacity: 0.7; font-size: 14px; max-width: 60ch; }
    .frame { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    footer { padding: 16px 20px; border-top: 1px solid var(--line); opacity: 0.6; font-size: 13px; }
    code { background: color-mix(in srgb, currentColor 10%, transparent); padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <strong>Acme</strong>
    <span style="opacity:.55;font-size:14px">Admin</span>
    <nav>
      <a href="#">Orders</a>
      <a href="#">Customers</a>
      <a href="#" aria-current="page">Traffic</a>
      <a href="#">Settings</a>
    </nav>
  </header>

  <main>
    <h1>Traffic</h1>
    <p class="lede">
      The operator dashboard, embedded in this page as <code>&lt;bot-dashboard&gt;</code> rather than
      served beside it. Same element, same data, inside our own chrome — and mounted at
      <code>/_bots</code> on this very origin, because the dashboard sends no CORS headers and the
      element refuses a cross-origin <code>src</code>.
    </p>

    <div class="frame">
      <bot-dashboard id="ops" src="/_bots"></bot-dashboard>
    </div>
  </main>

  <footer>
    A shadow root is a styling boundary, not a security boundary. A page hosting this belongs behind
    the same authentication as the dashboard itself.
  </footer>

  <script type="module">
    import { defineBotDashboard } from "/element.js";

    const node = document.getElementById("ops");
    // Set before the element is defined, which is the order the documentation asks for and
    // the one the accessor in the element is built to survive.
    node.config = {
      src: "/_bots",
      theme: { density: "compact" },
      // Where it opens. A served page keeps this in its URL; embedded there is no URL to
      // keep it in, so the host page says it instead.
      view: { tab: "live", filter: "all" },
      panels: [
        {
          id: "acme-orders",
          screen: "stats",
          title: "Checkout health",
          source: () => ({ rows: [{ label: "Orders today", value: 1284 }, { label: "Failed payments", value: 3 }] }),
        },
      ],
    };
    defineBotDashboard();
  </script>
</body>
</html>`;

/**
 * Credentials for the embedded dashboard, printed at start-up.
 *
 * Not decoration, and worth understanding before copying this file. `serveDashboard` owns
 * its listener, so it can see that it bound loopback and let the editor run without
 * authentication. A *mounted* handler cannot: it is a function inside somebody else's
 * server and has no idea what that server binds or who can reach it. So the library
 * refuses `controls.editPolicy` together with `auth: false` here — it will not take
 * "trust me" for an answer on a question it cannot check — and the demo authenticates
 * rather than turning the controls off, because the controls are what there is to show.
 *
 * Basic auth specifically, because the element fetches from this same origin with
 * `credentials: "same-origin"`: the browser prompts once and then attaches the credentials
 * to every request the dashboard makes, with nothing in the page having to know about it.
 */
const USER = "demo";
const PASSWORD = process.env["ADMIN_PASSWORD"] ?? "bothandler";

const mounted = createDashboardHandler(detector, {
  basePath: "/_bots",
  title: "Acme traffic",
  // On because this is a demo and pressing things is the point. All three are off by
  // default in the library: `reset` discards the actor registry, `editRanges` edits the
  // allowlist, and `editPolicy` rewrites the running rule set — and now also changes how
  // long the feed is kept, for everybody looking at it.
  controls: { reset: true, editPolicy: true, editRanges: true },
  auth: { username: USER, password: PASSWORD },
});

const seeded = await seed();
const element = await elementBundle();

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/element.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(element);
    return;
  }
  if (path?.startsWith("/_bots")) {
    void mounted(request, response);
    return;
  }
  if (path === "/" || path === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Pick another:\n\n      ADMIN_PORT=9685 npm run demo:embedded\n`);
  } else {
    console.error(`\n  The admin page failed to start: ${error.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log("  bothandlerjs — the dashboard embedded in your own page");
  console.log(line);
  console.log(`  admin page  http://localhost:${PORT}/     <- open this`);
  console.log(`  mounted at  http://localhost:${PORT}/_bots  (same origin, on purpose)`);
  console.log(`  sign in as  ${USER} / ${PASSWORD}`);
  console.log(`\n  ${seeded} corpus requests assessed, spread over the last 6 hours.`);
  console.log("  Nothing on this page is behind the bot handler, so reading it changes nothing.");
  console.log(`${line}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
