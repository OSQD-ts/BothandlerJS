/**
 * Choosing which language to challenge somebody in.
 *
 * The interstitial is the only page this library shows to a member of the public, and
 * it is shown to them because a *probabilistic* verdict went against them. Serving
 * "Checking your browser" in English to somebody whose browser has been asking for
 * Japanese since the first request is the same unfairness the guard exists to prevent,
 * applied to the one screen where it is most visible: a person who cannot read the page
 * cannot find the contact link on it either.
 *
 * The library ships no translations and will not. A machine-translated apology on a
 * page that just turned somebody away is worse than an honest English one — and only
 * the operator knows which languages their audience actually reads. What this does is
 * pick between the translations *you* supply.
 *
 * Pure and header-shaped, so it can be tested by calling it.
 */

/** One language's copy. Anything omitted falls back to the default text. */
export interface ChallengeCopy {
  title?: string;
  message?: string;
  contactHtml?: string;
  /**
   * The `lang` attribute to put on the document. Defaults to the key this copy is filed
   * under.
   *
   * It matters more than it looks: a screen reader picks its voice and its pronunciation
   * rules from this attribute, so Japanese text announced as `lang="en"` is read aloud
   * by an English voice and is unintelligible. Getting the copy right and the attribute
   * wrong helps nobody.
   */
  lang?: string;
}

/** How many entries of an `Accept-Language` header are worth reading. */
const MAX_TAGS = 20;

/**
 * The language tags in an `Accept-Language` header, best first.
 *
 * Lower-cased, `q` honoured, malformed entries dropped rather than fatal — this is a
 * client-supplied header and the page it decides is one somebody is already having a
 * bad time with. `*` is dropped too: it means "anything", which is what the default is
 * for.
 */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (header === undefined || header.trim() === "") return [];

  const entries: Array<{ tag: string; q: number; order: number }> = [];
  const parts = header.split(",").slice(0, MAX_TAGS);

  parts.forEach((part, order) => {
    const [rawTag, ...parameters] = part.trim().split(";");
    const tag = (rawTag ?? "").trim().toLowerCase();
    if (tag === "" || tag === "*" || !/^[a-z]{1,8}(-[a-z\d]{1,8})*$/.test(tag)) return;

    let q = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([\d.]+)\s*$/.exec(parameter);
      if (match !== null) {
        const parsed = Number(match[1]);
        // `q=0` means "explicitly not this one", which is a request to be honoured
        // rather than a low preference.
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q > 0) entries.push({ tag, q, order });
  });

  // Stable within a q value: a header listing two equally-weighted languages means the
  // first one, not whichever the sort happened to keep.
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries.map((entry) => entry.tag);
}

/**
 * The best available translation for what the client asked for.
 *
 * Exact tag first, then the primary subtag: somebody asking for `pt-BR` gets Brazilian
 * Portuguese if you supply it and European Portuguese if that is all you have, which is
 * far better than English. Somebody asking for `pt` never gets `pt-BR` silently,
 * because a regional variant is a claim about an audience rather than a fallback for
 * one.
 *
 * `undefined` means none matched, and the caller uses its defaults.
 */
export function pickTranslation(translations: Record<string, ChallengeCopy> | undefined, accepted: readonly string[]): { tag: string; copy: ChallengeCopy } | undefined {
  if (translations === undefined) return undefined;

  const available = new Map<string, string>();
  for (const key of Object.keys(translations)) available.set(key.toLowerCase(), key);

  for (const tag of accepted) {
    const exact = available.get(tag);
    if (exact !== undefined) return { tag: exact, copy: translations[exact] as ChallengeCopy };
  }
  for (const tag of accepted) {
    const primary = tag.split("-")[0] ?? "";
    const base = available.get(primary);
    if (base !== undefined) return { tag: base, copy: translations[base] as ChallengeCopy };
  }
  return undefined;
}
