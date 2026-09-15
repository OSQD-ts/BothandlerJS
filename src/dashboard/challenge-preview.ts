import { randomId } from "../internal/crypto.js";
import { TtlLru } from "../internal/lru.js";
import type { ChallengeAppearance } from "../challenge/appearance.js";
import type { Clock } from "../internal/clock.js";

/**
 * Trying the challenge page from the dashboard, as the page a visitor would get.
 *
 * A preview is a real interstitial, issued by the real service and solved by the real
 * script, rather than a picture of one. The only differences are where it is served and
 * who it is issued to: it comes from the dashboard's own listener so it can sit in a frame
 * on this page, and it is bound to a throwaway actor so solving it grants nothing to
 * anybody and puts nothing into the registry, the counters or the feed.
 *
 * Each preview is a short-lived session holding the draft it was opened with and, once
 * the check has been completed, what came of it. Bounded both ways: a dashboard left open
 * with the preview being refreshed should not grow without limit.
 */
export interface PreviewOutcome {
  ok: boolean;
  at: number;
  /** How long the visitor's side took, from the page being issued to the answer arriving. */
  elapsedMs: number;
  level?: string | undefined;
  reason?: string | undefined;
  interactionScore?: number | undefined;
}

export interface PreviewSession {
  id: string;
  appearance: ChallengeAppearance;
  /** Which of the page's languages to show, as a visitor's `Accept-Language` would pick it. */
  lang?: string | undefined;
  scheme?: "light" | "dark" | undefined;
  /** Whether the check actually runs, or the page is only drawn to be looked at. */
  live: boolean;
  issuedAt?: number | undefined;
  outcome?: PreviewOutcome | undefined;
}

const MAX_PREVIEWS = 32;
const PREVIEW_TTL_MS = 30 * 60_000;

export class ChallengePreviews {
  private readonly sessions: TtlLru<PreviewSession>;

  constructor(private readonly clock: Clock) {
    this.sessions = new TtlLru<PreviewSession>(MAX_PREVIEWS, PREVIEW_TTL_MS, clock);
  }

  open(appearance: ChallengeAppearance, options: { lang?: string | undefined; scheme?: "light" | "dark" | undefined; live?: boolean | undefined } = {}): PreviewSession {
    // Long and random because it is also what the frame's requests carry to find their
    // session — nothing about it should be guessable from another.
    const session: PreviewSession = { id: randomId(18), appearance, lang: options.lang, scheme: options.scheme, live: options.live === true };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | null | undefined): PreviewSession | undefined {
    return typeof id === "string" && id !== "" ? this.sessions.get(id) : undefined;
  }

  /** The actor a preview's challenge is bound to. Never a real client's key. */
  actorFor(session: PreviewSession): string {
    return `dashboard-preview:${session.id}`;
  }

  issued(session: PreviewSession): void {
    session.issuedAt = this.clock.now();
    session.outcome = undefined;
  }

  record(session: PreviewSession, outcome: Omit<PreviewOutcome, "at" | "elapsedMs">): PreviewOutcome {
    const at = this.clock.now();
    session.outcome = { ...outcome, at, elapsedMs: session.issuedAt === undefined ? 0 : Math.max(0, at - session.issuedAt) };
    return session.outcome;
  }
}

/**
 * The page a completed preview reloads into.
 *
 * On a real site the interstitial reloads into the page the visitor asked for. Here there
 * is no such page, and reloading into a fresh challenge would look exactly like a check
 * that failed and started again — so it lands on this instead, which says what happened.
 * No script at all, so the policy it is served under can forbid every one.
 */
export function renderPreviewOutcome(outcome: PreviewOutcome, againHref: string): string {
  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
  const seconds = outcome.elapsedMs < 1000 ? `${Math.round(outcome.elapsedMs)} ms` : `${(outcome.elapsedMs / 1000).toFixed(1)}s`;
  const heading = outcome.ok ? "Check passed" : "Check refused";
  const detail = outcome.ok
    ? `A visitor would now be sent on to the page they asked for, with a ${escapeHtml(outcome.level ?? "pow")} clearance. It took ${seconds} from the page appearing.`
    : `The server refused the answer: ${escapeHtml(outcome.reason ?? "no reason given")}. A visitor would see the page's own failure message and the contact details.`;
  const score = outcome.interactionScore === undefined ? "" : `<p>Gesture score ${outcome.interactionScore.toFixed(2)}.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --muted: #5b6270; --bg: #fbfbfc; --line: #e2e5ea; --ok: #1d7a45; --bad: #b02525; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8eaee; --muted: #98a0ae; --bg: #14161a; --line: #2a2e36; --ok: #4ec97a; --bad: #ff8078; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 30rem; border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { margin: 0 0 10px; font-size: 1.15rem; color: ${outcome.ok ? "var(--ok)" : "var(--bad)"}; }
  p { margin: 0 0 12px; color: var(--muted); }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  <p>${detail}</p>
  ${score}
  <p><a href="${escapeHtml(againHref)}">Run the check again</a></p>
</main>
</body>
</html>`;
}
