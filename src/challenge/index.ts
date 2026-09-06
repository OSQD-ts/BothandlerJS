import { renderChallengePage } from "./page.js";
import { parseAcceptLanguage, pickTranslation } from "./language.js";
import type { ChallengeCopy } from "./language.js";
import { clampDifficulty, verifyProofOfWork, DEFAULT_DIFFICULTY } from "./pow.js";
import { issueToken, newChallenge, newClearance, verifyToken } from "./token.js";
import { DEFAULT_INTERACTION_SETTINGS, parseInteractionReport, probeShapeFor, verifyInteraction } from "./interaction.js";
import type { InteractionSettings } from "./interaction.js";
import { serializeCookie } from "../internal/http.js";
import { shortHash } from "../internal/crypto.js";
import { systemClock } from "../internal/clock.js";
import type { Clock } from "../internal/clock.js";
import type { BotHandlerStore } from "../stores/types.js";
import type { ChallengeClaims, ClearanceClaims, ClearanceLevel } from "./token.js";

export { renderChallengePage } from "./page.js";
export { parseAcceptLanguage, pickTranslation } from "./language.js";
export type { ChallengeCopy } from "./language.js";
export type { ChallengePageOptions, RenderedChallenge } from "./page.js";
export { DEFAULT_DIFFICULTY, MAX_DIFFICULTY, clampDifficulty, countLeadingZeroBits, solveProofOfWork, verifyProofOfWork } from "./pow.js";
export { issueToken, verifyToken, newChallenge, newClearance } from "./token.js";
export type { ChallengeClaims, ClearanceClaims, ClearanceLevel, TokenVerification } from "./token.js";

export interface ChallengeOptions {
  /**
   * HMAC secrets. The first signs, all of them verify — prepend a new one and keep
   * the old for a token lifetime to rotate without logging anyone out.
   *
   * Required, with no default, on purpose: a library-supplied fallback secret is a
   * library-supplied forgery key, and it would end up in production somewhere.
   */
  secrets: readonly string[];
  /** Leading zero bits demanded. Default 16 — a few tens of ms in a browser. */
  difficulty?: number;
  /** How long a challenge may be solved for, ms. Default 120000. */
  challengeTtlMs?: number;
  /** How long a granted clearance lasts, ms. Default 3600000 (1h). */
  clearanceTtlMs?: number;
  /** Path the solution is POSTed to. Default "/__bothandler/verify". */
  verifyPath?: string;
  /** Cookie carrying the clearance. Default "__bh_clearance". */
  cookieName?: string;
  /** Emit `Secure`. Default true. Set false only for local plaintext development. */
  cookieSecure?: boolean;
  /** SameSite attribute. Default "Lax". */
  cookieSameSite?: "Lax" | "Strict" | "None";
  /** Page heading. */
  title?: string;
  /** Page body copy. */
  message?: string;
  /**
   * HTML shown to anyone the check locks out — no JavaScript, no WebCrypto, a device
   * too slow to finish. Supply something real: a support address, a phone number, a
   * link to a form. Everyone who sees it is a person your site just turned away.
   */
  contactHtml?: string;
  /**
   * Copy for other languages, keyed by language tag — `"ja"`, `"pt-BR"`, `"de"`.
   *
   * The interstitial is the only page this library shows to a member of the public, and
   * it is shown because a *probabilistic* verdict went against them. Somebody who
   * cannot read it cannot find the contact link on it either, which turns a check into
   * a wall.
   *
   * The library ships no translations and will not: a machine-translated apology on a
   * page that just turned somebody away is worse than an honest English one, and only
   * you know which languages your audience reads. Supply the ones you can stand behind
   * and the best match for each visitor's `Accept-Language` is chosen; anything you
   * leave out of a translation falls back to the default text.
   *
   * ```ts
   * translations: {
   *   ja: { title: "ブラウザーを確認しています", message: "数秒で完了します。" },
   *   "pt-BR": { title: "Verificando seu navegador" },
   * }
   * ```
   *
   * **Key by the primary tag** — `pt`, `zh`, `de` — unless you genuinely have separate
   * regional copy. Matching is exact-tag first and then primary-subtag, and it stops
   * there: a visitor asking for `pt-PT` will *not* be handed `pt-BR`. That looks
   * unhelpful until you consider the case it is protecting — serving Simplified Chinese
   * to somebody who asked for Traditional is a worse failure than serving English, and
   * no rule can tell the two situations apart. Whether one regional variant stands in
   * for another is a judgement about your audience, so it is made by which keys you
   * write rather than by a heuristic here.
   */
  translations?: Record<string, ChallengeCopy>;
  /**
   * Ask for a deliberate gesture as well as the proof of work, and measure what the
   * browser can actually do while waiting for it.
   *
   * `true` uses {@link DEFAULT_INTERACTION_SETTINGS}. Solving the puzzle alone no longer
   * grants clearance when this is on: the gesture is required. Read
   * `src/challenge/interaction.ts` before turning it on — in particular the part about
   * what is and is not verifiable — because it changes who can get through your site.
   */
  interaction?: boolean | Partial<InteractionSettings>;
  store?: BotHandlerStore;
  clock?: Clock;
}

export interface ChallengeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type SolutionOutcome =
  | { ok: true; setCookie: string; level: ClearanceLevel; interactionScore?: number; notes?: readonly string[] }
  | { ok: false; status: number; reason: string; interactionScore?: number | undefined };

/**
 * Issues challenges, verifies solutions and grants clearance.
 *
 * The lifecycle is deliberately stateless up to the moment of success. A challenge is
 * a signed blob the client carries; the server stores nothing while it is being
 * solved, so a flood of unsolved challenges costs nothing but the bytes to send them.
 * Exactly one piece of state is written, at the one moment it is indispensable: the
 * solved challenge's nonce is claimed atomically so a solution cannot be replayed.
 */
export class ChallengeService {
  private readonly secrets: readonly string[];
  private readonly difficulty: number;
  private readonly challengeTtlMs: number;
  private readonly clock: Clock;
  private readonly store: BotHandlerStore | undefined;
  /** Resolved interaction settings, or `undefined` when the gesture is not asked for. */
  private readonly interaction: InteractionSettings | undefined;
  readonly verifyPath: string;
  readonly cookieName: string;
  /**
   * How long a granted clearance lasts. Public because the engine mirrors it into its
   * own actor registry, and the two must expire together: a local record that outlives
   * the cookie hands a solved actor a window in which it is never re-challenged.
   */
  readonly clearanceTtlMs: number;

  constructor(private readonly options: ChallengeOptions) {
    if (options.secrets.length === 0) throw new Error("ChallengeService requires at least one secret");
    for (const secret of options.secrets) {
      // 32 bytes of entropy is the floor for an HMAC key that gates access.
      if (secret.length < 32) throw new Error("Each challenge secret must be at least 32 characters; generate one with `crypto.randomBytes(32).toString('base64url')`");
    }
    this.secrets = options.secrets;
    this.difficulty = clampDifficulty(options.difficulty ?? DEFAULT_DIFFICULTY);
    const wantsGesture = options.interaction !== undefined && options.interaction !== false;
    // Two minutes is the right budget for a puzzle a machine solves in milliseconds. It
    // is the wrong one for a page that stops and waits for a person to read it and act:
    // somebody using a screen reader that announces the whole page, on a slow device
    // where the proof of work itself takes twenty seconds, or simply interrupted, runs
    // out and is told to reload — having done nothing wrong and with no idea why.
    this.challengeTtlMs = options.challengeTtlMs ?? (wantsGesture ? 600_000 : 120_000);
    this.clearanceTtlMs = options.clearanceTtlMs ?? 3_600_000;
    this.verifyPath = options.verifyPath ?? "/__bothandler/verify";
    this.cookieName = options.cookieName ?? "__bh_clearance";
    this.clock = options.clock ?? systemClock;
    this.store = options.store;
    this.interaction = !wantsGesture
      ? undefined
      : { ...DEFAULT_INTERACTION_SETTINGS, ...(options.interaction === true ? {} : options.interaction) };
  }

  /** Whether this service asks for a gesture as well as the puzzle. */
  get wantsInteraction(): boolean {
    return this.interaction !== undefined;
  }

  /**
   * Derives the subject a token is bound to.
   *
   * The actor key is hashed rather than embedded, for two independent reasons. Tokens
   * are readable by the client, and the actor key is frequently an IP address — which
   * would mean handing every visitor a cookie containing their own address, and
   * anyone who obtained the cookie a record of where it was issued. Hashing under the
   * signing secret also means a token cannot be correlated across deployments.
   */
  subjectFor(actorKey: string): string {
    return shortHash(actorKey, this.secrets[0]!);
  }

  /**
   * Every subject this actor could legitimately be carrying, newest first.
   *
   * The subject is derived under a secret, so rotating secrets changes it — and
   * binding verification to `secrets[0]` alone would mean that prepending a new key
   * silently rejected every outstanding cookie as `wrong-actor`. The signature would
   * still verify against the retained old key; only the binding would fail. Every
   * visitor holding valid clearance would be sent back through the interstitial at the
   * moment of rotation, which is exactly the documented promise this class makes and
   * exactly the kind of quiet mass false positive the library exists to avoid.
   *
   * So the same rule the signature follows applies to the binding: the newest secret
   * mints, every configured secret verifies.
   */
  private subjectsFor(actorKey: string): string[] {
    return this.secrets.map((secret) => shortHash(actorKey, secret));
  }

  /**
   * Builds the full interstitial response for an actor.
   *
   * `acceptLanguage` is the visitor's header, and passing it is what lets the page be
   * written in a language they read. It is optional because a caller that has no request
   * to hand — a test, a script — should still be able to render one.
   */
  issue(actorKey: string, options: { acceptLanguage?: string | undefined } = {}): ChallengeResponse {
    const claims = newChallenge(this.subjectFor(actorKey), this.difficulty, this.challengeTtlMs, this.clock.now());
    const token = issueToken(claims, this.secrets);
    // The visitor's language, where one of yours matches. Everything the translation
    // omits falls through to the defaults below it, so a partial translation is a
    // partial improvement rather than a broken page.
    const chosen = pickTranslation(this.options.translations, parseAcceptLanguage(options.acceptLanguage));
    const title = chosen?.copy.title ?? this.options.title;
    const message = chosen?.copy.message ?? this.options.message;
    const contactHtml = chosen?.copy.contactHtml ?? this.options.contactHtml;
    const lang = chosen === undefined ? undefined : (chosen.copy.lang ?? chosen.tag);

    const rendered = renderChallengePage({
      challenge: token,
      difficulty: this.difficulty,
      verifyPath: this.verifyPath,
      ...(title !== undefined ? { title } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(contactHtml !== undefined ? { contactHtml } : {}),
      ...(lang !== undefined ? { lang } : {}),
      ...(this.interaction !== undefined ? { interaction: true, probe: probeShapeFor(claims.nonce, this.secrets[0] as string) } : {}),
    });

    return {
      // 429 rather than 403: this is "slow down and prove something", and it is
      // temporary and retryable, which is exactly what 429 means. A 403 tells caches
      // and crawlers the resource is forbidden outright.
      status: 429,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, private",
        // The page carries one inline script and nothing else. Locking the policy
        // this far down means the interstitial cannot be turned into a fetch primitive.
        "content-security-policy": `default-src 'none'; script-src 'nonce-${rendered.scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
      body: rendered.html,
    };
  }

  /**
   * Validates a submitted solution and, on success, returns the `Set-Cookie` that
   * grants clearance.
   *
   * The checks run in the order that costs least on the way to a rejection:
   * signature, then binding, then expiry, then the hash, then the replay claim. The
   * expensive shared-state round trip happens only for a submission that has already
   * proven itself in every cheaper respect.
   */
  async verifySolution(actorKey: string, payload: unknown): Promise<SolutionOutcome> {
    if (typeof payload !== "object" || payload === null) return { ok: false, status: 400, reason: "malformed body" };
    const { challenge, solution } = payload as { challenge?: unknown; solution?: unknown };
    if (typeof challenge !== "string" || typeof solution !== "string") {
      return { ok: false, status: 400, reason: "challenge and solution must be strings" };
    }

    const verified = verifyToken<ChallengeClaims>(challenge, this.secrets, this.clock.now(), this.subjectsFor(actorKey));
    if (!verified.ok) {
      // `wrong-actor` is its own case: a solution valid for someone else usually means
      // a shared address changed behind a NAT, not an attack.
      const status = verified.reason === "expired" || verified.reason === "wrong-actor" ? 409 : 400;
      return { ok: false, status, reason: verified.reason };
    }

    if (!verifyProofOfWork(verified.payload.nonce, solution, verified.payload.diff)) {
      return { ok: false, status: 400, reason: "solution does not satisfy the challenge" };
    }

    // The gesture, when one was asked for. Deliberately after the proof of work and
    // before the replay claim: a submission that has not solved the puzzle has not
    // earned the CPU this costs, and one that fails here should not burn its nonce.
    let level: ClearanceLevel = "pow";
    let interactionScore: number | undefined;
    let notes: readonly string[] | undefined;

    if (this.interaction !== undefined) {
      const report = parseInteractionReport((payload as { interaction?: unknown }).interaction);
      // Measured here rather than taken from the report: `iat` is inside the signed
      // token, so this is real time that passed on this server, and it is the one thing
      // in the whole exchange the client cannot lie about.
      const elapsedMs = this.clock.now() - verified.payload.iat;
      const outcome = verifyInteraction(report, elapsedMs, this.interaction, probeShapeFor(verified.payload.nonce, this.secrets[0] as string));
      if (!outcome.ok) {
        return { ok: false, status: 400, reason: outcome.reason, ...(outcome.score === undefined ? {} : { interactionScore: outcome.score }) };
      }
      level = outcome.level;
      interactionScore = outcome.score;
      notes = outcome.notes;
    }

    if (this.store) {
      let claimed: boolean;
      try {
        claimed = await this.store.consumeOnce(`pow:${verified.payload.nonce}`, this.challengeTtlMs);
      } catch {
        // Store outage. Accept the solution: it is cryptographically valid and
        // correctly solved, and refusing it would lock out real visitors because our
        // Redis is unhappy. Replay resistance is the thing we give up, not access.
        claimed = true;
      }
      if (!claimed) return { ok: false, status: 409, reason: "challenge already solved" };
    }

    return {
      ok: true,
      level,
      setCookie: this.grant(actorKey, level),
      ...(interactionScore === undefined ? {} : { interactionScore }),
      ...(notes === undefined ? {} : { notes }),
    };
  }

  /**
   * Mints a clearance cookie directly, bypassing the puzzle.
   *
   * Use it the moment your application knows something the request cannot show — a
   * completed login, a verified payment, a session you already trust. `operator`
   * level is the only clearance this library treats as conclusive proof of a person,
   * precisely because the assertion comes from your code rather than from the client.
   */
  grant(actorKey: string, level: ClearanceLevel = "operator"): string {
    const claims = newClearance(this.subjectFor(actorKey), level, this.clearanceTtlMs, this.clock.now());
    return serializeCookie(this.cookieName, issueToken(claims, this.secrets), {
      maxAgeMs: this.clearanceTtlMs,
      sameSite: this.options.cookieSameSite ?? "Lax",
      secure: this.options.cookieSecure ?? true,
      httpOnly: true,
      path: "/",
    });
  }

  /** Reads and validates the clearance cookie for an actor. Returns `undefined` if there is none valid. */
  read(actorKey: string, cookies: Record<string, string> | undefined): ClearanceClaims | undefined {
    const token = cookies?.[this.cookieName];
    if (token === undefined) return undefined;
    const verified = verifyToken<ClearanceClaims>(token, this.secrets, this.clock.now(), this.subjectsFor(actorKey));
    return verified.ok ? verified.payload : undefined;
  }

  /** A `Set-Cookie` that removes any clearance. Call it on logout. */
  revoke(): string {
    return serializeCookie(this.cookieName, "", {
      maxAgeMs: 0,
      sameSite: this.options.cookieSameSite ?? "Lax",
      secure: this.options.cookieSecure ?? true,
      httpOnly: true,
      path: "/",
    });
  }
}
