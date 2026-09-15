import type { ChallengeCopy } from "./language.js";

/**
 * What an operator can change about the interstitial without a deploy: the words, where
 * a person who is stuck should turn, the language it declares, and the accent colour.
 *
 * Deliberately only the page. Difficulty, the gesture and the secrets decide who gets
 * through, and a form on a dashboard is the wrong place to loosen any of them — so they
 * stay in code, exactly as the guard's thresholds do.
 *
 * Everything here arrives from a form and ends up on the one page the public sees, so it
 * is checked field by field and refused whole rather than trimmed into something the
 * operator did not write. The colours are the strict case: they are written into a
 * stylesheet, so a value that is not a plain hex colour is a way to write CSS, and is
 * refused.
 */
export interface ChallengeAppearance {
  /** Page heading. */
  title?: string;
  /** Page body copy. */
  message?: string;
  /** HTML shown to anyone the check locks out. Scripts in it do not run: the page's CSP admits only its own. */
  contactHtml?: string;
  /** The document's `lang` attribute for the default copy. */
  lang?: string;
  /** Accent colour in the light scheme, `#rgb` or `#rrggbb`. */
  accent?: string;
  /** Accent colour in the dark scheme, `#rgb` or `#rrggbb`. */
  accentDark?: string;
  /** Copy for other languages, keyed by language tag. See `ChallengeOptions.translations`. */
  translations?: Record<string, ChallengeCopy>;
}

export const APPEARANCE_LIMITS = { title: 120, message: 800, contactHtml: 4000, lang: 35, translations: 40 } as const;

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

/** Whether a string is a colour this page will write into its stylesheet. */
export function isHexColour(value: string): boolean {
  return HEX_COLOUR.test(value);
}

/** Whether a string is shaped like a language tag. Not a registry lookup — a shape check. */
export function isLanguageTag(value: string): boolean {
  return LANGUAGE_TAG.test(value);
}

type TextField = "title" | "message" | "contactHtml";

function text(raw: Record<string, unknown>, field: TextField, where: string, errors: string[]): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    errors.push(`${where}${field} must be text.`);
    return undefined;
  }
  // Empty means "use the default", which is what clearing a box on a form means too.
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > APPEARANCE_LIMITS[field]) {
    errors.push(`${where}${field} is ${trimmed.length} characters; the most is ${APPEARANCE_LIMITS[field]}.`);
    return undefined;
  }
  return trimmed;
}

function tag(value: unknown, what: string, errors: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > APPEARANCE_LIMITS.lang || !isLanguageTag(value.trim())) {
    errors.push(`${what} "${String(value)}" is not a language tag like "en", "de" or "pt-BR".`);
    return undefined;
  }
  return value.trim();
}

function colour(value: unknown, what: string, errors: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !isHexColour(value.trim())) {
    errors.push(`${what} "${String(value)}" is not a colour like #2f6feb.`);
    return undefined;
  }
  return value.trim().toLowerCase();
}

/**
 * A submitted appearance, checked. `errors` is empty when every field was usable; when it
 * is not, callers refuse the whole submission rather than applying the parts that passed.
 */
export function cleanAppearance(value: unknown): { appearance: ChallengeAppearance; errors: string[] } {
  const errors: string[] = [];
  const appearance: ChallengeAppearance = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { appearance, errors: ["The challenge page settings must be an object."] };
  }
  const raw = value as Record<string, unknown>;

  for (const field of ["title", "message", "contactHtml"] as const) {
    const cleaned = text(raw, field, "", errors);
    if (cleaned !== undefined) appearance[field] = cleaned;
  }
  const lang = tag(raw["lang"], "lang", errors);
  if (lang !== undefined) appearance.lang = lang;
  const accent = colour(raw["accent"], "accent", errors);
  if (accent !== undefined) appearance.accent = accent;
  const accentDark = colour(raw["accentDark"], "accentDark", errors);
  if (accentDark !== undefined) appearance.accentDark = accentDark;

  const translations = raw["translations"];
  if (translations !== undefined && translations !== null) {
    if (typeof translations !== "object" || Array.isArray(translations)) {
      errors.push("translations must be an object keyed by language tag.");
    } else {
      const entries = Object.entries(translations as Record<string, unknown>);
      if (entries.length > APPEARANCE_LIMITS.translations) errors.push(`${entries.length} translations; the most is ${APPEARANCE_LIMITS.translations}.`);
      const cleaned: Record<string, ChallengeCopy> = {};
      for (const [key, copyValue] of entries.slice(0, APPEARANCE_LIMITS.translations)) {
        const language = tag(key, "Translation", errors);
        if (language === undefined) continue;
        if (typeof copyValue !== "object" || copyValue === null || Array.isArray(copyValue)) {
          errors.push(`The "${language}" translation must be an object.`);
          continue;
        }
        const copyRaw = copyValue as Record<string, unknown>;
        const copy: ChallengeCopy = {};
        for (const field of ["title", "message", "contactHtml"] as const) {
          const cleanedField = text(copyRaw, field, `The "${language}" translation's `, errors);
          if (cleanedField !== undefined) copy[field] = cleanedField;
        }
        const copyLang = tag(copyRaw["lang"], `The "${language}" translation's lang`, errors);
        if (copyLang !== undefined) copy.lang = copyLang;
        // A translation with nothing in it changes nothing, so it is not kept.
        if (Object.keys(copy).length > 0) cleaned[language] = copy;
      }
      if (Object.keys(cleaned).length > 0) appearance.translations = cleaned;
    }
  }

  return { appearance, errors };
}
