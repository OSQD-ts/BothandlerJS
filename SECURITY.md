# Security

## Reporting a vulnerability

Email **platosz.michal@gmail.com** with `[bothandlerjs]` in the subject. Please do not
open a public issue for anything exploitable. Include a reproduction if you can; you
will get an acknowledgement within a few days.

---

## What this library is, in security terms

A **traffic classifier** with a response layer. It is *not* a security boundary, and
nothing about your access control should depend on it. Treat a bot verdict the way you
would treat a spam score: useful input to a decision, never the decision itself.

Concretely, it does not replace authentication, authorisation, input validation, rate
limits on privileged operations, or a WAF. A determined adversary who defeats
detection should find nothing behind it that detection was protecting.

---

## Threat model

### Defended against

| Threat | How |
| ------ | --- |
| **Crawler impersonation** — forging `Googlebot` to get privileged treatment | Forward-confirmed reverse DNS, or operator-published IP ranges. Both directions are checked, so a forgery is *proven* rather than suspected. |
| **Allowlist bypass by address spelling** | Addresses are parsed to bytes and compared numerically. `::ffff:127.0.0.1`, `0177.0.0.1` and `127.0.0.001` cannot slip past a range that a string comparison would miss; ambiguous forms are rejected outright rather than guessed at. |
| **Actor-key spoofing via `X-Forwarded-For`** | The header is ignored unless `trustProxy` is on. With `trustedProxies` the chain is walked from the right past your own infrastructure, so a client-prepended hop cannot choose the address it is tracked under. When `hops` is used and the chain turns out to be *shorter* than configured, the socket address is used — a short chain means the request did not traverse the expected topology, so every entry in it is client-controlled. |
| **Absence treated as evidence on a header-poor source** | `RequestFacts.partialHeaders` marks a record whose header set is incomplete, and every detector that reasons from a missing header stands down. Without it, replaying an access log — which records two headers — makes ordinary browsers look like clients that sent no `Accept` and no `Accept-Language`. |
| **Challenge replay** | Solutions are single-use, claimed with one atomic check-and-set. On multiple replicas this requires a shared store; the in-memory one is documented as per-instance. |
| **Challenge forgery** | Challenges and clearances are HMAC-signed. The signature is verified *before* any claim is read, and every comparison of a secret-derived value is constant-time. |
| **Clearance theft** | Tokens are bound to the actor. A cookie lifted from one client is invalid under a different actor key. |
| **Response splitting through verdict headers** | Header values are partly derived from client input (an evidence summary can quote a User-Agent), so every one is stripped of C0 controls and DEL and truncated. |
| **Path-based rule evasion** | Paths are decoded exactly once, backslashes normalised, duplicate slashes collapsed, and `.`/`..` resolved before any rule sees them. Decoding once is deliberate: repeated decoding is how `%2525` becomes `%`. |
| **Prototype pollution via query or cookies** | Query and cookie bags are null-prototype, so `__proto__=x` becomes an ordinary own key that detectors can see rather than vanishing into a setter. |
| **Memory exhaustion** | Every structure keyed by client-controlled input is a bounded LRU with a fixed per-entry budget. There is no configuration that makes any of them unbounded. |
| **Denial of service through detection cost** | I/O detectors are individually timeout-bounded and run concurrently; a promise returned by a detector declared `cheap` is timed out too. DNS is cached and only runs when an identity was actually claimed. |
| **Detector-induced outage** | Every detector, notification sink and store call is failure-isolated. A throw, a rejection or a hang degrades exactly that component and is reported through `onError`. |
| **Alerting used as an amplifier** | Notifications are deduplicated per actor and capped per window, and never run on the request path. A scrape cannot page you into an outage. |

### Explicitly out of scope

- **A well-resourced adversary.** Real Chrome, residential proxies, human pacing,
  correct headers, proof of work solved. At that point the difference from a person has
  stopped being technical. This library raises cost, not an impassable wall.
- **Signature accuracy over time.** A signature is a claim about a *population* of
  clients, and populations change. `Electron/` was classified as proven automation
  here until it turned out to be what VS Code's Simple Browser, Slack and Postman
  send — a real Chromium with a person driving it. `BotSignature.conclusive: false`
  exists for that case, but nothing detects the next one for you.
- **Client-side integrity.** Everything the browser script reports is client-asserted
  and forgeable in one line. That is why `client-signals` is permanently capped at
  `moderate` and can never reach a blocking action.
- **Proof of humanity.** Nothing here provides it. Proof of work proves CPU.
- **Distributed low-and-slow abuse.** One request per address per hour from a large
  pool defeats every behavioural signal by construction.

---

## Operational guidance

**Secrets.** `challenge.secrets` must be at least 32 characters and come from a secret
manager, never from source. Generate with
`crypto.randomBytes(32).toString("base64url")`. Rotate by prepending a new secret and
keeping the old one for at least one clearance lifetime.

**Fail open.** Every failure path in this library serves the request. A bot filter that
fails closed is an outage with extra steps. If you change that, know that you have.

**Verdict headers.** Leave `exposeVerdictHeaders` off in production. An `X-Bot-Score`
in the response is a live feedback signal for anyone tuning a scraper against you —
they change one header, watch the number fall, and iterate. Request-side tagging gives
your application the same information and tells the client nothing.

**Metrics endpoints.** `prometheus()` exposes per-detector firing counts. Those
describe how detection behaves, which is what someone tuning a scraper against you
would most like to read. Serve it where only your scraper can reach it.

**Denylists.** A denylist entry produces `certain` evidence and can therefore block.
That is correct — it is your explicit decision — but it means a wrong entry blocks real
people with no probabilistic guard to catch it. Review them.

**Loopback.** Do not allowlist `127.0.0.1`. Behind nginx or beside a sidecar, every
request in the world arrives from there and the allowlist silently disables the library.

**Privacy.** Assessments contain full headers and the client address. Notification
payloads are masked to a `/24` or `/64` and stripped of credential headers before
leaving the process; your own logs are not, and an IP address is personal data in most
jurisdictions. Clearance cookies contain no personal data — the actor key is stored as
a keyed hash, never in the clear.

**Challenges exclude people.** Anyone without JavaScript, without WebCrypto, or on a
device too slow to finish is locked out. Always set `contactHtml` to something real.
