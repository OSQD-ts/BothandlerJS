import { $, byId, clear, el, label, rootNode } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { authed, getJson, postJson } from "./api.js";
import { toast } from "./app.js";

/**
 * The Challenge screen: the interstitial a visitor sees, edited, previewed and tried.
 *
 * Three things somebody designing that page needs and did not have. What it looks like,
 * without deploying and then getting themselves challenged. Whether it still works once
 * they have changed it — so the preview is the real page, solved by its real script
 * against the real service, in a frame. And for the result to still be there tomorrow,
 * so a save goes to the listener and, when it has one, to a file.
 *
 * The form holds a draft. The preview follows the draft as it is typed, and nothing
 * reaches a visitor until Save.
 */
interface Copy {
  title?: string;
  message?: string;
  contactHtml?: string;
  lang?: string;
}

interface Appearance extends Copy {
  accent?: string;
  accentDark?: string;
  translations?: Record<string, Copy>;
}

interface ChallengeState {
  /** Whether the handler has a challenge configured. Without one, the preview still works and a save waits for it. */
  configured: boolean;
  editable: boolean;
  /** Where saves go, when anywhere. */
  file: string | null;
  interaction: boolean;
  difficulty: number;
  /** The page as the running handler would serve it now. */
  effective: Appearance;
  /** What code configured, before anything was saved over it. */
  code: Appearance;
  /** What the dashboard has saved over the code, if anything. */
  saved: Appearance | null;
  /** The library's own words, for the placeholders. */
  defaults: { title: string; message: string; accent: string; accentDark: string };
}

interface PreviewOpened {
  id: string;
}

interface PreviewOutcome {
  ok: boolean;
  elapsedMs: number;
  level?: string;
  reason?: string;
  interactionScore?: number;
}

let current: ChallengeState | undefined;
let draft: Appearance = {};
let loading = false;
let previewId = "";
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let scheme: "light" | "dark" = "light";
let language = "";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A draft with the cleared fields taken out, so "unsaved" compares what would actually be sent. */
function compact(appearance: Appearance): Appearance {
  const out: Appearance = {};
  for (const key of ["title", "message", "contactHtml", "lang", "accent", "accentDark"] as const) {
    const value = appearance[key]?.trim();
    if (value !== undefined && value !== "") out[key] = value;
  }
  const translations: Record<string, Copy> = {};
  for (const [tag, copy] of Object.entries(appearance.translations ?? {})) {
    const cleaned: Copy = {};
    for (const key of ["title", "message", "contactHtml", "lang"] as const) {
      const value = copy[key]?.trim();
      if (value !== undefined && value !== "") cleaned[key] = value;
    }
    if (tag.trim() !== "" && Object.keys(cleaned).length > 0) translations[tag.trim()] = cleaned;
  }
  if (Object.keys(translations).length > 0) out.translations = translations;
  return out;
}

function dirty(): boolean {
  return current !== undefined && JSON.stringify(compact(draft)) !== JSON.stringify(compact(current.effective));
}

export async function loadChallenge(): Promise<void> {
  if (!SECTIONS.challenge || loading) return;
  loading = true;
  try {
    current = await getJson<ChallengeState>("/api/challenge");
    draft = clone(current.effective);
    drawForm();
    schedulePreview(0);
  } catch (error) {
    $("challenge-status").textContent = `The challenge page could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading = false;
  }
}

/** Called on every frame the screen is showing. Loads once; everything after is driven by the form. */
export function drawChallengeTab(): void {
  if (!SECTIONS.challenge) return;
  if (current === undefined) {
    void loadChallenge();
    return;
  }
  // The result is polled only while somebody is looking at it.
  if (pollTimer === undefined && previewId !== "" && $("challenge-preview-state").textContent === "running the check") startPolling();
}

/** Stops the polling when the screen is left. */
export function leaveChallengeTab(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
}

// ---- the form -------------------------------------------------------------------

function field(name: string, control: HTMLElement, hint?: string, labelled: HTMLElement = control): HTMLElement {
  const row = el("div", "field");
  row.appendChild(label(name, labelled));
  const right = el("div", "field-stack");
  right.appendChild(control);
  if (hint !== undefined) right.appendChild(el("span", "hint", hint));
  row.appendChild(right);
  return row;
}

function textBox(value: string | undefined, placeholder: string, onInput: (value: string) => void, options: { multiline?: number; mono?: boolean; max?: number } = {}): HTMLInputElement | HTMLTextAreaElement {
  const control = options.multiline !== undefined ? el("textarea", `challenge-text${options.mono === true ? " mono-input" : ""}`) : el("input", options.mono === true ? "mono-input" : null);
  if (control instanceof HTMLTextAreaElement) control.rows = options.multiline ?? 3;
  else control.type = "text";
  control.value = value ?? "";
  control.placeholder = placeholder;
  control.spellcheck = options.mono !== true;
  if (options.max !== undefined) control.maxLength = options.max;
  control.addEventListener("input", () => {
    onInput(control.value);
    changed();
  });
  return control;
}

function colourPicker(value: string | undefined, fallback: string, name: string, onInput: (value: string) => void): { row: HTMLElement; typed: HTMLInputElement } {
  const row = el("div", "field-row");
  const picker = el("input");
  picker.type = "color";
  picker.value = value ?? fallback;
  picker.setAttribute("aria-label", `${name}, colour picker`);
  const typed = el("input", "mono-input colour-text");
  typed.type = "text";
  typed.value = value ?? "";
  typed.placeholder = fallback;
  typed.maxLength = 7;
  typed.setAttribute("aria-label", `${name}, as a hex colour`);
  picker.addEventListener("input", () => {
    typed.value = picker.value;
    onInput(picker.value);
    changed();
  });
  typed.addEventListener("input", () => {
    if (/^#[0-9a-f]{6}$/i.test(typed.value)) picker.value = typed.value;
    onInput(typed.value);
    changed();
  });
  row.append(picker, typed);
  return { row, typed };
}

function drawForm(): void {
  const state = current;
  if (state === undefined) return;
  const form = $("challenge-form");
  clear(form);

  $("challenge-mode").textContent = state.editable ? "editable" : "read-only";
  byId<HTMLButtonElement>("challenge-save").hidden = !state.editable;
  byId<HTMLButtonElement>("challenge-reset").hidden = !state.editable || state.saved === null;

  const status: string[] = [];
  if (!state.configured) status.push("No challenge is configured on this handler, so no visitor sees this page yet. The preview works; a saved page applies once challenge.secrets is set.");
  status.push(
    state.file === null
      ? "Saves apply to the running handler and last until it restarts. Set challengePage.file on the dashboard to keep them."
      : `Saves apply to the running handler and are written to ${state.file}.`,
  );
  if (!state.editable) status.push("Read-only: enable controls.editChallenge to save from here. The preview still works.");
  status.push(state.interaction ? `Difficulty ${state.difficulty} and the gesture stay in code.` : `Difficulty ${state.difficulty} stays in code, and no gesture is asked for.`);
  $("challenge-status").textContent = status.join(" ");

  const main = el("fieldset", "challenge-group");
  main.appendChild(el("legend", null, "Default page"));
  main.appendChild(field("Heading", textBox(draft.title, state.defaults.title, (value) => (draft.title = value), { max: 120 })));
  main.appendChild(field("Message", textBox(draft.message, state.defaults.message, (value) => (draft.message = value), { multiline: 3, max: 800 })));
  main.appendChild(
    field(
      "Contact",
      textBox(draft.contactHtml, '<a href="mailto:support@example.com">Contact support</a>', (value) => (draft.contactHtml = value), { multiline: 3, mono: true, max: 4000 }),
      "HTML, shown to anyone who cannot complete the check. Scripts in it do not run.",
    ),
  );
  main.appendChild(field("Language", textBox(draft.lang, "en", (value) => (draft.lang = value), { mono: true, max: 35 }), "The page's lang attribute, which picks a screen reader's voice."));
  form.appendChild(main);

  const look = el("fieldset", "challenge-group");
  look.appendChild(el("legend", null, "Colour"));
  const light = colourPicker(draft.accent, state.defaults.accent, "Accent in the light scheme", (value) => (draft.accent = value));
  look.appendChild(field("Light", light.row, undefined, light.typed));
  const dark = colourPicker(draft.accentDark, state.defaults.accentDark, "Accent in the dark scheme", (value) => (draft.accentDark = value));
  look.appendChild(field("Dark", dark.row, undefined, dark.typed));
  form.appendChild(look);

  const translations = el("fieldset", "challenge-group");
  translations.appendChild(el("legend", null, "Other languages"));
  translations.appendChild(el("p", "hint", "Each visitor gets the best match for their browser's languages. Anything a translation leaves empty falls back to the default page."));
  const entries = Object.entries(draft.translations ?? {});
  entries.forEach(([tag, copy], index) => translations.appendChild(translationRow(tag, copy, index)));
  const add = el("button", null, "+ Add a language");
  add.type = "button";
  add.addEventListener("click", () => {
    draft.translations = { ...(draft.translations ?? {}), [nextTag()]: {} };
    drawForm();
    changed();
    const tags = rootNode().querySelectorAll<HTMLInputElement>(".translation input.translation-tag");
    tags[tags.length - 1]?.focus();
  });
  translations.appendChild(add);
  form.appendChild(translations);

  drawLanguages();
  reflectDirty();
}

function nextTag(): string {
  const taken = new Set(Object.keys(draft.translations ?? {}));
  for (const candidate of ["de", "fr", "es", "ja", "pt", "it", "nl", "pl"]) if (!taken.has(candidate)) return candidate;
  let n = 1;
  while (taken.has(`xx-${n}`)) n++;
  return `xx-${n}`;
}

function translationRow(tag: string, copy: Copy, index: number): HTMLElement {
  const row = el("div", "translation");
  let key = tag;
  const tagInput = el("input", "mono-input translation-tag");
  tagInput.type = "text";
  tagInput.value = tag;
  tagInput.maxLength = 35;
  tagInput.setAttribute("aria-label", `Language tag for translation ${index + 1}`);
  tagInput.addEventListener("change", () => {
    const next = tagInput.value.trim();
    if (next === key || next === "") {
      tagInput.value = key;
      return;
    }
    const entries = Object.entries(draft.translations ?? {}).map(([existing, value]) => [existing === key ? next : existing, value] as const);
    draft.translations = Object.fromEntries(entries);
    key = next;
    drawLanguages();
    changed();
  });
  const remove = el("button", "danger", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    const rest = { ...(draft.translations ?? {}) };
    delete rest[key];
    draft.translations = rest;
    if (language === key) language = "";
    drawForm();
    changed();
  });
  const head = el("div", "translation-head");
  head.append(tagInput, remove);
  row.appendChild(head);
  const edit = (name: keyof Copy) => (value: string) => {
    const translationsNow = draft.translations ?? {};
    translationsNow[key] = { ...(translationsNow[key] ?? {}), [name]: value };
    draft.translations = translationsNow;
  };
  row.appendChild(field("Heading", textBox(copy.title, "Falls back to the default heading", edit("title"), { max: 120 })));
  row.appendChild(field("Message", textBox(copy.message, "Falls back to the default message", edit("message"), { multiline: 2, max: 800 })));
  row.appendChild(field("Contact", textBox(copy.contactHtml, "Falls back to the default contact", edit("contactHtml"), { multiline: 2, mono: true, max: 4000 })));
  return row;
}

function drawLanguages(): void {
  const select = byId<HTMLSelectElement>("challenge-lang");
  const tags = Object.keys(draft.translations ?? {}).filter((tag) => tag.trim() !== "");
  if (language !== "" && !tags.includes(language)) language = "";
  clear(select);
  const base = el("option", null, `Default${draft.lang ? ` (${draft.lang})` : ""}`);
  base.value = "";
  select.appendChild(base);
  for (const tag of tags) {
    const option = el("option", null, tag);
    option.value = tag;
    select.appendChild(option);
  }
  select.value = language;
  select.disabled = tags.length === 0;
}

function reflectDirty(): void {
  const isDirty = dirty();
  $("challenge-dirty").hidden = !isDirty;
  byId<HTMLButtonElement>("challenge-save").disabled = !isDirty;
  byId<HTMLButtonElement>("challenge-revert").disabled = !isDirty;
}

function changed(): void {
  reflectDirty();
  schedulePreview(700);
}

// ---- the preview -------------------------------------------------------------------

function schedulePreview(delayMs: number): void {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void openPreview(false), delayMs);
}

/**
 * Opens the page in the frame. Held, it is drawn and frozen with its check not started —
 * which is what following the form needs, because a running check at a preview's
 * difficulty finishes and reloads before anybody has seen the page. Live, it runs for
 * real and the result is reported below it.
 */
async function openPreview(live: boolean): Promise<void> {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  const outcome = $("challenge-outcome");
  const result = await postJson<PreviewOpened>("/api/challenge/preview", { appearance: compact(draft), lang: language || undefined, scheme, live });
  if (!result.ok) {
    outcome.className = "challenge-outcome bad";
    outcome.textContent = result.error ?? "The preview was refused.";
    return;
  }
  previewId = result.data.id;
  byId<HTMLIFrameElement>("challenge-frame").src = authed(`/api/challenge/frame?id=${encodeURIComponent(previewId)}`);
  $("challenge-preview-state").textContent = live ? "running the check" : "follows the form";
  outcome.className = "challenge-outcome";
  if (!live) {
    leaveChallengeTab();
    outcome.textContent = "";
    return;
  }
  outcome.textContent = current?.interaction === true ? "Running the check. Tick the box in the page to finish it." : "Running the check in the page above…";
  startPolling();
}

function startPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  const polling = previewId;
  pollTimer = setInterval(() => {
    if (previewId !== polling) return;
    void getJson<{ outcome: PreviewOutcome | null }>(`/api/challenge/result?id=${encodeURIComponent(polling)}`)
      .then((body) => {
        if (body.outcome === null || previewId !== polling) return;
        showOutcome(body.outcome);
        leaveChallengeTab();
      })
      .catch(() => {
        /* the next tick asks again; an expired preview is replaced by the next edit */
      });
  }, 1000);
}

function showOutcome(result: PreviewOutcome): void {
  const outcome = $("challenge-outcome");
  outcome.className = `challenge-outcome ${result.ok ? "ok" : "bad"}`;
  // Milliseconds below a second: at a low difficulty the check finishes in tens of them,
  // and "0.0s" reads as though nothing ran.
  const seconds = result.elapsedMs < 1000 ? `${Math.round(result.elapsedMs)} ms` : `${(result.elapsedMs / 1000).toFixed(1)}s`;
  outcome.textContent = result.ok
    ? `Passed in ${seconds} — the page works, and a visitor would get a ${result.level ?? "pow"} clearance.${result.interactionScore === undefined ? "" : ` Gesture score ${result.interactionScore.toFixed(2)}.`}`
    : `Refused after ${seconds}: ${result.reason ?? "no reason given"}.`;
}

// ---- saving ------------------------------------------------------------------------

async function save(appearance: Appearance, message: string): Promise<void> {
  const result = await postJson<ChallengeState>("/api/challenge", { appearance });
  if (!result.ok) {
    toast("bad", "Challenge page not saved", result.error ?? "");
    return;
  }
  current = result.data;
  draft = clone(current.effective);
  drawForm();
  toast("ok", message, current.file === null ? "Applied. It lasts until the process restarts." : `Applied, and written to ${current.file}.`);
  schedulePreview(0);
}

export function initChallenge(): void {
  if (!SECTIONS.challenge) return;
  byId<HTMLButtonElement>("challenge-save").addEventListener("click", () => void save(compact(draft), "Challenge page saved"));
  byId<HTMLButtonElement>("challenge-revert").addEventListener("click", () => {
    if (current === undefined) return;
    draft = clone(current.effective);
    drawForm();
    schedulePreview(0);
  });
  byId<HTMLButtonElement>("challenge-reset").addEventListener("click", () => void save({}, "Challenge page reset to the one in code"));
  byId<HTMLButtonElement>("challenge-try").addEventListener("click", () => void openPreview(true));
  byId<HTMLSelectElement>("challenge-lang").addEventListener("change", (event) => {
    language = (event.target as HTMLSelectElement).value;
    schedulePreview(0);
  });
  for (const button of Array.from($("challenge-scheme").querySelectorAll<HTMLButtonElement>("button"))) {
    button.addEventListener("click", () => {
      scheme = button.dataset["scheme"] === "dark" ? "dark" : "light";
      for (const other of Array.from($("challenge-scheme").querySelectorAll<HTMLButtonElement>("button"))) other.setAttribute("aria-pressed", String(other === button));
      schedulePreview(0);
    });
  }
}
