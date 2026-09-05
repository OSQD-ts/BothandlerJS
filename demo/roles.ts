#!/usr/bin/env tsx
/**
 * Role-gated dashboards.
 *
 *   npm run demo:roles
 *
 *   :9683  a small protected site, plus an operator console to sign in at
 *   :9684  the **analyst** dashboard — read-only, and with the evidence and the policy
 *          taken off it entirely
 *   :9685  the **operator** dashboard — the policy editor and reset
 *   :9686  the **admin** dashboard — the above, plus the guard itself
 *
 * The library's dashboard takes `auth: { authorize }`, which hands you the raw
 * `IncomingMessage` and asks one question: may this request touch the dashboard at
 * all? That is deliberately the *only* question it asks. There is no role model in
 * here, no user table, no session store — because every one of those already exists
 * in your application, and a second copy that disagrees with the first is worse than
 * none.
 *
 * So this file is a worked answer to "can I put roles in front of it?". The answer is
 * yes, and it takes two things:
 *
 *   1. Something that proves who is asking. Here, an HMAC-signed cookie. In your
 *      deployment: your session store, your SSO gateway's header, an mTLS subject,
 *      a JWT from your IdP. `authorize` does not care which.
 *
 *   2. One dashboard per capability. `controls` — what a viewer may *do* — and
 *      `sections` — what a viewer may *see* — are both fixed when the listener starts
 *      and not evaluated per request, so "analysts may look, operators may change the
 *      rules, admins may change the guard" is three listeners over the same handler
 *      rather than one listener with three kinds of visitor. `serveDashboard` holds no
 *      singleton state, so calling it three times is fine and all three stay live
 *      against the same engine.
 *
 * The ladder below is the point. Each rung adds exactly one thing, and the two most
 * consequential ones are the last two: `editPolicy` can write a rule that overreaches,
 * and the guard stops it — while `editGuard` changes whether anything stops it.
 *
 * The thing that makes one sign-in cover all three ports is worth knowing rather than
 * discovering: **cookies are scoped by host, not by origin.** A cookie set on
 * `localhost:9683` is sent to `localhost:9684` and `:9685` too, because the port is
 * not part of a cookie's identity. Convenient here. Also the reason a stray service
 * on a developer's laptop can read a session cookie your app set — which is an
 * argument for `__Host-` prefixes and real hostnames in production, not for relying
 * on this.
 */
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { BotHandler, createFacts, parseCookies, serializeCookie } from "../src/index.js";
import { botHandler } from "../src/adapters/index.js";
import type { IncomingMessage } from "node:http";

const SITE_PORT = Number(process.env["SITE_PORT"] ?? 9683);
const VIEWER_PORT = Number(process.env["VIEWER_PORT"] ?? 9684);
const OPERATOR_PORT = Number(process.env["OPERATOR_PORT"] ?? 9685);
const ADMIN_PORT = Number(process.env["ADMIN_PORT"] ?? 9686);

/**
 * Demo only, and the one line to delete first.
 *
 * A signing key checked into a repository is a forgery key checked into a
 * repository: anyone holding it can mint themselves the `admin` cookie below. The
 * library refuses to supply a default secret anywhere for exactly this reason, and
 * this file only gets away with it by never leaving loopback.
 */
const SESSION_SECRET = "demo-operator-session-secret-do-not-ship";
const COOKIE = "bh_operator";
const SESSION_TTL_MS = 30 * 60_000;

type Role = "analyst" | "operator" | "admin";

const ROLES: Record<Role, { label: string; may: string; user: string }> = {
  analyst: { label: "Analyst", may: "read the feed — but not the evidence behind each verdict, and not the policy", user: "sam@example.com" },
  operator: { label: "Operator", may: "everything an analyst may, plus the evidence, the policy editor and reset", user: "ola@example.com" },
  admin: { label: "Admin", may: "everything an operator may, plus change the guard itself and act on a single client", user: "ada@example.com" },
};

interface Session {
  user: string;
  role: Role;
  exp: number;
}

// ---------------------------------------------------------------------------
// The session. Signed, not encrypted — the same choice the library makes for its
// clearance tokens, and for the same reason: the client may read every claim, so
// nothing secret goes in one. What the signature buys is that nobody can promote
// themselves from `analyst` to `admin` by editing a cookie.
// ---------------------------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

/** Constant-time, because a session verifier is exactly the kind of oracle a timing attack likes. */
function signatureMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function issueSession(user: string, role: Role): string {
  const payload = Buffer.from(JSON.stringify({ user, role, exp: Date.now() + SESSION_TTL_MS }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * The whole of the trust decision, in one place.
 *
 * Note the order: the signature is verified *before* any claim is read. Reading `exp`
 * or `role` out of an unverified cookie to decide whether the signature is worth
 * checking is the classic way to turn a signed token into an unsigned one.
 */
function readSession(request: IncomingMessage): Session | undefined {
  const raw = parseCookies(request.headers.cookie)[COOKIE];
  if (raw === undefined) return undefined;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const payload = raw.slice(0, separator);
  if (!signatureMatches(raw.slice(separator + 1), sign(payload))) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return undefined;
    if (!Object.prototype.hasOwnProperty.call(ROLES, claims.role)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/**
 * What `auth: { authorize }` actually wants: a predicate over the raw request.
 *
 * It returns the viewer's *name* rather than `true`, which is the whole of what the
 * dashboard needs to attribute a change. Every rule applied, guard moved, range edited
 * or actor forgotten from these pages is announced with " by ada@example.com" on it —
 * in the handler's `warning`, in the change event, and on the marker it leaves on the
 * traffic timeline. An empty string would be a refusal, so this returns `false`.
 */
const hasRole =
  (...allowed: readonly Role[]) =>
  (request: IncomingMessage): string | false => {
    const session = readSession(request);
    return session !== undefined && allowed.includes(session.role) ? session.user : false;
  };

// ---------------------------------------------------------------------------
// The engine. Ordinary — nothing here knows about roles.
// ---------------------------------------------------------------------------

const detector = new BotHandler({
  preset: "protect-content",
  // The operator console is not traffic to be judged. Excluding it is the same
  // instinct that puts the dashboard on its own listener: a tool for reading about
  // your traffic should not become a row in it, and a challenge served to the console
  // would lock you out of the thing you are using to investigate.
  ignorePaths: ["/operator/", "/healthz"],
  metrics: { perDetectorTiming: true },
  // Both runtime changes are announced. `guard-change` is the one worth wiring to a
  // pager: it carries the before and the after of the setting that decides whether an
  // unproven verdict can deny anybody.
  onPolicyChange: ({ rules, by }) => console.log(`  [policy-change] ${rules.length} rule(s): ${rules.join(", ")}${by === undefined ? "" : ` (by ${by})`}`),
  onGuardChange: ({ before, after, by }) => console.log(`  [guard-change]  ${before.falsePositivePolicy} → ${after.falsePositivePolicy}, fallback ${after.fallbackAction}${by === undefined ? "" : ` (by ${by})`}`),
  onRangeChange: ({ name, size, by }) => console.log(`  [range-change]  ${name}: ${size} entries${by === undefined ? "" : ` (by ${by})`}`),
  onActorChange: ({ key, action, by }) => console.log(`  [actor-change]  ${key} ${action}${by === undefined ? "" : ` (by ${by})`}`),
});

// ---------------------------------------------------------------------------
// :9684, :9685 and :9686 — three dashboards, one handler, three answers to "who".
// ---------------------------------------------------------------------------

const console_ = { label: "Operator console", href: `http://localhost:${SITE_PORT}/operator` };

const viewer = await detector.serveDashboard({
  port: VIEWER_PORT,
  title: "bothandlerjs — analyst",
  auth: { authorize: hasRole("analyst", "operator", "admin") },
  // No `controls` at all. The editor and the reset button are not merely hidden here;
  // the server answers 403 to both endpoints, because a hidden button is a decision
  // about a page and this is a decision about a listener.
  //
  // `sections` goes further than hiding too. The evidence panel names the exact signal
  // that fired on each request, which is a tuning guide for whoever is scraping you —
  // so on the widest-shared listener it is not sent at all. Open devtools on this one
  // and the entries have no `evidence`, no headers and no query parameters in them.
  sections: { evidence: false, policy: false },
  redact: { maskIp: true },
  links: [console_],
});

const operator = await detector.serveDashboard({
  port: OPERATOR_PORT,
  title: "bothandlerjs — operator",
  auth: { authorize: hasRole("operator", "admin") },
  // May change which rules exist. May not change how far a rule is allowed to go: the
  // guard panel here is read-only, and `/api/guard` answers 403.
  controls: { editPolicy: true, reset: true },
  links: [console_],
});

const admin = await detector.serveDashboard({
  port: ADMIN_PORT,
  title: "bothandlerjs — admin",
  auth: { authorize: hasRole("admin") },
  // The one listener that can move `falsePositivePolicy` off `strict` — which is the
  // one change that lets an unproven verdict deny somebody. Every change here is
  // announced through `warning` and `guard-change`, both of which this demo prints.
  controls: { editPolicy: true, editGuard: true, editRanges: true, reset: true },
  links: [console_],
});

// ---------------------------------------------------------------------------
// :9683 — the protected site, and the operator console to sign in at.
// ---------------------------------------------------------------------------

const site = express();
site.use(express.urlencoded({ extended: false, limit: "8kb" }));
site.use(botHandler(detector));

site.get("/healthz", (_request, response) => response.type("text/plain").send("ok"));

site.get("/operator", (request, response) => {
  const session = readSession(request as unknown as IncomingMessage);
  response.type("html").send(session === undefined ? signInPage() : signedInPage(session));
});

site.post("/operator/session", (request, response) => {
  const role = String((request.body as Record<string, unknown>)["role"] ?? "");
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) {
    response.status(400).type("text/plain").send("Pick a role.\n");
    return;
  }
  // No password, on purpose. This demo is about *authorisation* — what a proven
  // identity is allowed to reach — and a hand-rolled password form beside it would be
  // the least trustworthy thing on the page. In your deployment the identity arrives
  // from your IdP and this handler does not exist.
  response.setHeader(
    "set-cookie",
    serializeCookie(COOKIE, issueSession(ROLES[role as Role].user, role as Role), {
      maxAgeMs: SESSION_TTL_MS,
      httpOnly: true,
      sameSite: "Lax",
      secure: false, // plaintext localhost only; `true` everywhere real
    }),
  );
  response.redirect(302, "/operator");
});

site.post("/operator/signout", (_request, response) => {
  response.setHeader("set-cookie", serializeCookie(COOKIE, "", { maxAgeMs: 0, httpOnly: true, sameSite: "Lax", secure: false }));
  response.redirect(302, "/operator");
});

site.get("/products", (_request, response) => response.type("html").send(shell("Products", "<p>Forty widgets, and a scraper's favourite page.</p>")));
site.get("/api/items", (_request, response) => response.json(Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Widget ${i + 1}` }))));
site.get("/", (_request, response) =>
  response.type("html").send(
    shell(
      "A protected site",
      `<p>Every request here is assessed. What you can see of that depends on the role
          you are holding.</p>
       <ul>
         <li><a href="/products">/products</a> and <a href="/api/items">/api/items</a> — make some traffic</li>
         <li><a href="/operator">/operator</a> — pick a role, then open a dashboard</li>
       </ul>`,
    ),
  ),
);

// ---------------------------------------------------------------------------

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark}
  body{max-width:46rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  code{background:color-mix(in srgb,currentColor 10%,transparent);padding:.1em .35em;border-radius:4px}
  .card{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:10px;padding:1rem 1.25rem;margin:1rem 0}
  .muted{opacity:.72;font-size:.925rem}
  button{font:inherit;padding:.45rem .9rem;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);background:transparent;color:inherit;cursor:pointer}
  a.button{display:inline-block;text-decoration:none;padding:.45rem .9rem;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 30%,transparent)}
  ul{padding-left:1.2rem}
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function signInPage(): string {
  const options = (Object.keys(ROLES) as Role[])
    .map(
      (role) => `<form method="post" action="/operator/session" class="card">
           <input type="hidden" name="role" value="${role}">
           <strong>${ROLES[role].label}</strong>
           <p class="muted">May ${ROLES[role].may}.</p>
           <button type="submit">Sign in as ${ROLES[role].label}</button>
         </form>`,
    )
    .join("");

  return shell(
    "Operator console",
    `<p>Hold a role, then try both dashboards. No password: this demonstrates what a
        proven identity may <em>reach</em>, and the proving is your identity
        provider's job.</p>
     ${options}
     <p class="muted">Signing in sets an HMAC-signed cookie on <code>localhost</code>.
        Because cookies are scoped by host and not by port, the dashboards on
        :${VIEWER_PORT}, :${OPERATOR_PORT} and :${ADMIN_PORT} see it too.</p>`,
  );
}

function signedInPage(session: Session): string {
  return shell(
    "Operator console",
    `<div class="card">
       <p>Signed in as <strong>${escapeHtml(session.user)}</strong> — role
          <strong>${escapeHtml(ROLES[session.role].label)}</strong>.</p>
       <p class="muted">Expires ${new Date(session.exp).toLocaleTimeString()}.</p>
       <form method="post" action="/operator/signout"><button type="submit">Sign out</button></form>
     </div>
     <p>
       <a class="button" href="http://localhost:${VIEWER_PORT}/">Analyst dashboard</a>
       <a class="button" href="http://localhost:${OPERATOR_PORT}/">Operator dashboard</a>
       <a class="button" href="http://localhost:${ADMIN_PORT}/">Admin dashboard</a>
     </p>
     <p class="muted">As an analyst the other two answer <code>401</code>, and they
        answer it for every path — authentication runs before routing, so a caller
        without the role cannot even map the endpoints. Note that the 401 is bare: a
        custom <code>authorize</code> sends no <code>WWW-Authenticate</code>, so the
        browser shows no prompt. Come back here to change role.</p>
     <p class="muted">The analyst dashboard has two tabs rather than three, and opening
        a row shows what happened without saying which detector fired. That is
        <code>sections</code>, and it is enforced on the server: the evidence is not
        withheld from the page, it is never sent to it.</p>
     <p class="muted">The session cookie is not what stops a forged write. A browser
        attaches it to a cross-site request as willingly as to a real one, which is why
        the dashboard checks <code>Sec-Fetch-Site</code> and insists on a JSON body
        before it will change anything.</p>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** A little traffic, so the feed is not empty the first time a dashboard is opened. */
async function seed(): Promise<void> {
  const clients = [
    { ua: "curl/8.4.0", ip: "203.0.113.10", path: "/api/items" },
    { ua: "python-requests/2.32.3", ip: "203.0.113.11", path: "/products" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", ip: "198.51.100.20", path: "/" },
    { ua: "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)", ip: "198.51.100.30", path: "/products" },
  ];
  for (const client of clients) {
    await detector.handle(
      createFacts({
        method: "GET",
        url: client.path,
        headers: { host: `localhost:${SITE_PORT}`, "user-agent": client.ua, accept: "*/*" },
        ip: client.ip,
        protocol: "http",
        httpVersion: "1.1",
      }),
    );
  }
}

const listener = site.listen(SITE_PORT, () => {
  void seed();
  const line = "─".repeat(66);
  console.log(`\n${line}`);
  console.log("  bothandlerjs — role-gated dashboards");
  console.log(line);
  console.log(`  start here   http://localhost:${SITE_PORT}/operator     <- pick a role`);
  console.log(`  site         http://localhost:${SITE_PORT}/`);
  console.log(`  analyst      ${viewer.url}  read-only, no evidence, no policy`);
  console.log(`  operator     ${operator.url}  editor + reset`);
  console.log(`  admin        ${admin.url}  the above, plus the guard and the allowlist`);
  console.log(`\n  Try it as an analyst, then open the admin dashboard: 401 on every path.`);
  console.log(`${line}\n`);
});

listener.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Port ${SITE_PORT} is in use. Pick others:\n`);
    console.error(`      SITE_PORT=9783 VIEWER_PORT=9784 OPERATOR_PORT=9785 ADMIN_PORT=9786 npm run demo:roles\n`);
  } else {
    console.error(`\n  The site failed to start: ${error.message}\n`);
  }
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    listener.close();
    void Promise.all([viewer.close(), admin.close()]).then(() => process.exit(0));
  });
}
