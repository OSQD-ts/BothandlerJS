import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * What is this request *asking for*?
 *
 * Every other detector here reads the client. This one reads the request target, and
 * it exists because of a gap the rest of the library cannot close: the scanner that
 * does not announce itself. `self-identified` catches sqlmap and Nikto because they
 * say so, and a great deal of hostile traffic does say so. The rest arrives wearing a
 * copied Chrome User-Agent, and from the headers alone it is indistinguishable from a
 * person — until you look at what it asked for, which is `/.env`, then
 * `/.git/config`, then `/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php`.
 *
 * Those paths are not obscure corners of a site. They are entries in a wordlist. No
 * link points at them, no menu leads to them, and no person types them — the traffic
 * that requests them is running a list against every address it can reach.
 *
 * **Why this stops at `strong` and never reaches `certain`.** The library's rule is
 * that `certain` evidence must admit no benign explanation, and a *request target*
 * always admits one: a URL is client-supplied text, and the client supplying it might
 * be a security engineer testing their own site from a laptop, a researcher with a
 * bug-bounty scope, or a monitoring check somebody wrote at three in the morning.
 * Those are people, and the correct response to them is a challenge, not a closed
 * door. A trap path is different — it is unreachable *by construction*, which is
 * exactly the property a wordlist entry lacks.
 *
 * **What it does not do.** It reads one request at a time. A scanner walking a
 * wordlist produces one of these observations per request rather than an escalating
 * series, because nothing here remembers that the same actor asked for `/.env` a
 * moment ago — the detectors that watch an actor over time are `rate-anomaly`,
 * `cadence` and `crawl-breadth`, and enumeration shows up there. Keeping this one
 * stateless is what lets it run unchanged over a log file in `replay`.
 *
 * **The one thing to configure.** The `platform` tier below is a list of admin and
 * login paths that are probes on most sites and are the *front door* on the sites
 * that run those platforms. If you run WordPress, `/wp-login.php` is where your
 * authors sign in, and this detector will report each of them as a probe. Add such
 * paths to `ignore`, or to the engine's `ignorePaths`, before turning any of this into
 * a rule. The tier is capped at `moderate` precisely so that forgetting costs a
 * tag rather than a door.
 */
export interface ProbeSignatureOptions {
  /**
   * Paths this site genuinely serves, exempted from the platform tier. Matched as
   * prefixes, so `/wp-admin` covers everything beneath it.
   */
  ignore?: readonly string[];
  /** Additional exact paths or prefixes to treat as exploit-tier probes. */
  extraPaths?: readonly string[];
}

/**
 * Tier one: targets and payloads with no legitimate reading.
 *
 * A request for a credential file, a version-control directory or a known
 * remote-execution endpoint is not a mis-click. Neither is a query string carrying a
 * JNDI lookup or a SQL union. These are matched as prefixes on the *normalised* path,
 * which matters: `facts.path` has already been percent-decoded once and had its `..`
 * segments resolved, so `/..%2f..%2fetc/passwd` arrives here as `/etc/passwd` and the
 * table does not need an entry for every spelling.
 */
const EXPLOIT_PATHS: readonly string[] = [
  "/.env",
  "/.git",
  "/.svn",
  "/.hg",
  "/.aws",
  "/.ssh",
  "/.npmrc",
  "/.bash_history",
  "/etc/passwd",
  "/etc/shadow",
  "/proc/self/environ",
  "/vendor/phpunit",
  "/_ignition/execute-solution",
  "/actuator/env",
  "/actuator/heapdump",
  "/solr/admin/info",
  "/manager/html",
  "/jenkins/script",
  "/console/login",
  "/cgi-bin/",
  "/boaform/",
  "/hudson",
  "/druid/indexer",
  "/_all_dbs",
  "/config.json.bak",
  "/wp-config.php.bak",
  "/telescope/requests",
  "/debug/default/view",
  "/idx_config",
  "/geoserver/web",
];

/** Filenames that are only ever fetched by something looking for a mistake. */
// `.pem` is deliberately absent: plenty of sites publish a CA or server certificate
// for people to download, and the file extension alone cannot tell that apart from a
// leaked private key.
const EXPLOIT_SUFFIXES: readonly string[] = [".sql", ".sql.gz", ".bak", ".old", ".swp", "id_rsa", ".kdbx", "credentials.json", "shell.php", "wso.php", "alfa.php"];

/**
 * Tier two: real front doors on the platforms that use them.
 *
 * Everything here is a probe on a site that does not run the platform and an ordinary
 * page on a site that does — hence `moderate`, hence the `ignore` option.
 */
const PLATFORM_PATHS: readonly string[] = [
  "/wp-login.php",
  "/wp-admin",
  "/wp-content/plugins",
  "/xmlrpc.php",
  "/administrator",
  "/admin.php",
  "/phpmyadmin",
  "/pma",
  "/adminer.php",
  "/phpinfo.php",
  "/info.php",
  "/server-status",
  "/server-info",
  "/.htaccess",
  "/web.config",
  "/config.php",
  "/backup",
  "/dbadmin",
  "/mysqladmin",
  "/typo3/index.php",
  "/api/jsonws/invoke",
];

/**
 * Payload shapes in a query value or a path segment.
 *
 * Deliberately narrow, and split by how much of the observation is the payload itself.
 * A generic "looks like SQL" pattern fires on a search box — someone looking up
 * `union select` in the documentation of a database — and a generic "looks like HTML"
 * pattern fires on a CMS preview and on every forum thread about cross-site
 * scripting. Those are people, reading a site about the thing the pattern describes.
 *
 * So `sql` and `markup` patterns are reported at `moderate` on their own and are
 * promoted to `strong` only when the value also carries **injection punctuation** — a
 * quote, a comment marker, a statement separator — which is the part a person
 * searching for the phrase does not type and the part an injection cannot work
 * without. `always` patterns need no such qualification: nobody searches for a JNDI
 * lookup with a live LDAP URL in it.
 */
type PayloadTier = "always" | "sql" | "markup";

const PAYLOADS: ReadonlyArray<{ pattern: RegExp; what: string; tier: PayloadTier }> = [
  { pattern: /\$\{jndi:/i, what: "a JNDI lookup (Log4Shell)", tier: "always" },
  { pattern: /(?:^|[;&|`])\s*(?:wget|curl|nc|bash|sh)\s+/i, what: "a shell command chained onto a parameter", tier: "always" },
  // Narrow on purpose: a bare `$( )` or a backtick pair appears in any search box on
  // a documentation site. A substitution is only interesting when it is substituting
  // a command.
  { pattern: /[$`]\(?\s*(?:cat|ls|id|whoami|uname|curl|wget|nc|sh|bash|python|perl)\b/i, what: "a shell substitution around a command", tier: "always" },
  { pattern: /(?:file|php|expect):\/\//i, what: "a non-HTTP URL scheme in a parameter", tier: "always" },
  { pattern: /\bunion\s+(?:all\s+)?select\b/i, what: "a SQL UNION SELECT", tier: "sql" },
  { pattern: /\bor\s+['"]?1['"]?\s*=\s*['"]?1/i, what: "a SQL tautology", tier: "sql" },
  { pattern: /\b(?:sleep|pg_sleep|waitfor\s+delay)\s*\(/i, what: "a SQL time-delay probe", tier: "sql" },
  { pattern: /<script[\s>]/i, what: "an inline script tag", tier: "markup" },
  { pattern: /\bon(?:error|load|mouseover)\s*=/i, what: "an inline event handler", tier: "markup" },
];

/** Quotes, comment markers and separators — the syntax an injection needs and a search does not. */
const INJECTION_PUNCTUATION = /['"]|--\s|\/\*|;|%27|%22/;

/** Methods a browser never issues and a scanner routinely does. */
const PROBE_METHODS = new Set(["TRACE", "TRACK", "DEBUG", "CONNECT"]);

export function probeSignatureDetector(options: ProbeSignatureOptions = {}): Detector {
  const ignore = options.ignore ?? [];
  const exploit = options.extraPaths !== undefined ? [...EXPLOIT_PATHS, ...options.extraPaths] : EXPLOIT_PATHS;

  return {
    id: "probe-signature",
    description: "Reads the request target for paths, payloads and methods that appear only in scanner wordlists",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const { path, query, method } = ctx.facts;
      const lowerPath = path.toLowerCase();
      const results: Evidence[] = [];

      if (PROBE_METHODS.has(method)) {
        results.push({
          detector: "probe-signature",
          summary: `Request method is ${method}, which browsers do not issue and scanners use to fingerprint a server`,
          direction: "bot",
          certainty: "strong",
          weight: 0.65,
          botClass: "scanner",
          metadata: { method },
        });
      }

      const hit = exploit.find((entry) => matchesPath(lowerPath, entry)) ?? suffixHit(lowerPath);
      if (hit !== undefined) {
        results.push({
          detector: "probe-signature",
          summary: `Requested ${path}, which no link on a site points to and no person types`,
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "scanner",
          family: "wordlist-probe",
          metadata: { path: path.slice(0, 120), matched: hit },
        });
      } else if (!ignore.some((entry) => matchesPath(lowerPath, entry.toLowerCase()))) {
        const platform = PLATFORM_PATHS.find((entry) => matchesPath(lowerPath, entry));
        if (platform !== undefined) {
          results.push({
            detector: "probe-signature",
            summary: `Requested ${path}, a platform administration path that is a probe on a site not running it`,
            direction: "bot",
            // Capped here on purpose: on a site that *does* run the platform, this is
            // the login page and the client is an administrator.
            certainty: "moderate",
            weight: 0.3,
            botClass: "scanner",
            family: "wordlist-probe",
            metadata: { path: path.slice(0, 120), matched: platform, note: "Add this path to `ignore` if your site serves it" },
          });
        }
      }

      // Payloads are read from the query and from the path, both of which are bounded
      // by `createFacts` before they get here.
      const payload = findPayload(path, query);
      if (payload !== undefined) {
        const proven = payload.tier === "always" || INJECTION_PUNCTUATION.test(payload.sample);
        results.push({
          detector: "probe-signature",
          summary: `Request carries ${payload.what} in its ${payload.where}`,
          direction: "bot",
          certainty: proven ? "strong" : "moderate",
          weight: proven ? 0.65 : 0.3,
          botClass: "scanner",
          metadata: { where: payload.where, sample: payload.sample.slice(0, 120), withInjectionSyntax: proven },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

/**
 * Whether a path is, or is inside, a listed target.
 *
 * The boundary characters are the whole point. A plain `startsWith` makes `/backup`
 * match `/backup-your-data-a-guide`, which is an article, and reports a reader of it
 * as a scanner. Matching only at a segment or extension boundary keeps `/.env.local`
 * and `/.git/config` while leaving ordinary URLs alone.
 */
function matchesPath(lowerPath: string, entry: string): boolean {
  if (!lowerPath.startsWith(entry)) return false;
  if (lowerPath.length === entry.length) return true;
  const next = lowerPath.charCodeAt(entry.length);
  return next === 0x2f /* / */ || next === 0x2e /* . */ || entry.endsWith("/");
}

function suffixHit(lowerPath: string): string | undefined {
  return EXPLOIT_SUFFIXES.find((suffix) => lowerPath.endsWith(suffix));
}

interface PayloadHit {
  what: string;
  where: string;
  sample: string;
  tier: PayloadTier;
}

function findPayload(path: string, query: Record<string, string>): PayloadHit | undefined {
  for (const { pattern, what, tier } of PAYLOADS) {
    if (pattern.test(path)) return { what, where: "path", sample: path, tier };
  }
  for (const [key, value] of Object.entries(query)) {
    for (const { pattern, what, tier } of PAYLOADS) {
      if (pattern.test(value)) return { what, where: `query parameter "${key.slice(0, 40)}"`, sample: value, tier };
    }
  }
  return undefined;
}
