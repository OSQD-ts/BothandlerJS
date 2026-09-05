import { $, byId, clear, el, label } from "./dom.js";
import { API, SECTIONS } from "./boot.js";
import { app, download, today, toast } from "./app.js";
import { getJson, postJson } from "./api.js";
import { actionKind } from "./outcome.js";
import { drawGuard, resetGuardDraft } from "./guard.js";
import { drawRanges } from "./ranges.js";
import { n } from "./format.js";
import { renderPreview, showResult } from "./result.js";
import { state } from "./store.js";
import { draftRule } from "./draft.js";
import type { EditorRule } from "./draft.js";
import type { DashboardEntry, Policy, Preview } from "./types.js";

/**
 * The rule editor works on a model — an array of plain rule objects — and both views
 * render from it. The GUI mutates the model in place on each keystroke, which is what
 * keeps focus and cursor position while somebody types; only structural changes (add,
 * remove, move, a different action) re-render a card.
 */
export async function loadPolicy(): Promise<void> {
  if (!SECTIONS.policy) return;
  try {
    const document_ = await getJson<Policy>("/api/policy");
    state.policy = document_;
    if (!state.editorDirty) {
      setEditorRules(document_.rules.filter((row) => row.editable).map((row) => row.rule as unknown as EditorRule));
    }
    if (!state.guardDirty) resetGuardDraft();
    drawPolicyTab();
  } catch {
    /* the page still works without it */
  }
}

function setEditorRules(rules: readonly EditorRule[]): void {
  state.editorRules = JSON.parse(JSON.stringify(rules ?? [])) as EditorRule[];
  renderEditor();
}

function markDirty(): void {
  state.editorDirty = true;
  $("policy-dirty").hidden = false;
}

function editorRules(): { rules?: EditorRule[]; error?: string } {
  if (state.editorMode === "json") {
    try {
      const parsed: unknown = JSON.parse(byId<HTMLTextAreaElement>("policy-json").value);
      if (!Array.isArray(parsed)) return { error: "The JSON must be an array of rules." };
      return { rules: parsed as EditorRule[] };
    } catch (error) {
      return { error: `The editor does not contain valid JSON: ${String(error)}` };
    }
  }
  return { rules: state.editorRules };
}

/** Strips the empty fields a form inevitably leaves behind, so the JSON stays readable. */
function cleanRule(rule: EditorRule): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule.match ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    match[key] = value;
  }
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule.params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "limit") {
      const limit = value as { max?: unknown; windowMs?: unknown };
      if (limit.max === undefined || limit.windowMs === undefined) continue;
    }
    params[key] = value;
  }
  const out: Record<string, unknown> = { id: rule.id, match, action: rule.action };
  if (Object.keys(params).length > 0) out["params"] = params;
  if (rule.reason !== undefined && rule.reason !== "") out["reason"] = rule.reason;
  return out;
}

function cleanRules(rules: readonly EditorRule[]): Array<Record<string, unknown>> {
  return rules.map(cleanRule);
}

// ---- field widgets ---------------------------------------------------------

function field(name: string, control: HTMLElement | HTMLElement[], hint?: string): HTMLElement {
  const row = el("div", "field");
  row.appendChild(label(name, control));
  const right = el("div", "field-row");
  for (const node of Array.isArray(control) ? control : [control]) right.appendChild(node);
  if (hint !== undefined) right.appendChild(el("span", "hint", hint));
  row.appendChild(right);
  return row;
}

function chipSelect(options: readonly string[], selected: unknown, onChange: (value: string[] | undefined) => void): HTMLElement {
  const box = el("div", "chips-select");
  const chosen: string[] = Array.isArray(selected) ? [...(selected as string[])] : selected === undefined ? [] : [String(selected)];
  for (const option of options) {
    const button = el("button", null, option);
    button.type = "button";
    button.setAttribute("aria-pressed", String(chosen.includes(option)));
    button.addEventListener("click", () => {
      const at = chosen.indexOf(option);
      if (at === -1) chosen.push(option);
      else chosen.splice(at, 1);
      button.setAttribute("aria-pressed", String(at === -1));
      onChange(chosen.length === 0 ? undefined : [...chosen]);
    });
    box.appendChild(button);
  }
  return box;
}

function segmented<T>(options: Array<[string, T]>, value: T, onChange: (value: T) => void): HTMLElement {
  const box = el("div", "seg");
  for (const [label, option] of options) {
    const button = el("button", null, label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(option === value));
    button.addEventListener("click", () => {
      for (const other of Array.from(box.children)) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      onChange(option);
    });
    box.appendChild(button);
  }
  return box;
}

function textInput(value: unknown, placeholder: string, onChange: (value: string | undefined) => void, mono = false): HTMLInputElement {
  const input = el("input", mono ? "mono-input" : null);
  input.type = "text";
  input.value = value === undefined || value === null ? "" : String(value);
  input.placeholder = placeholder;
  input.addEventListener("input", () => onChange(input.value.trim() === "" ? undefined : input.value));
  return input;
}

/** A comma-separated list, because a tag widget is a lot of keyboard surface for one path. */
function listInput(value: unknown, placeholder: string, onChange: (value: string | string[] | undefined) => void): HTMLInputElement {
  const current = value === undefined ? "" : Array.isArray(value) ? (value as string[]).join(", ") : String(value);
  const input = textInput(current, placeholder, () => {}, true);
  input.addEventListener("input", () => {
    const parts = input.value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    onChange(parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : parts);
  });
  return input;
}

function numberInput(value: unknown, placeholder: string, onChange: (value: number | undefined) => void): HTMLInputElement {
  const input = el("input");
  input.type = "number";
  input.value = value === undefined || value === null ? "" : String(value);
  input.placeholder = placeholder;
  input.addEventListener("input", () => onChange(input.value === "" ? undefined : Number(input.value)));
  return input;
}

// ---- one rule --------------------------------------------------------------

/** What a collapsed card says about itself: the match, in the order a reader scans it. */
function matchSummary(rule: EditorRule): HTMLElement {
  const box = el("div", "rule-summary");
  const match = rule.match ?? {};
  const parts: Array<[string, string]> = [];
  for (const key of ["verdict", "botClass", "category", "identity", "detector", "method", "path"]) {
    const value = match[key];
    if (value === undefined) continue;
    parts.push([key, Array.isArray(value) ? (value as string[]).join(", ") : String(value)]);
  }
  if (match["certain"] !== undefined) parts.push(["certain", String(match["certain"])]);
  if (match["minScore"] !== undefined || match["maxScore"] !== undefined) {
    parts.push(["score", `${String(match["minScore"] ?? 0)}–${String(match["maxScore"] ?? 99)}`]);
  }
  if (match["minPriorConfirmations"] !== undefined) parts.push(["prior", String(match["minPriorConfirmations"])]);
  if (match["minUnsolvedChallenges"] !== undefined) parts.push(["unsolved", String(match["minUnsolvedChallenges"])]);

  if (parts.length === 0) {
    box.appendChild(el("span", "none", "matches everything"));
    return box;
  }
  for (const [key, value] of parts.slice(0, 4)) box.appendChild(el("span", "t", `${key}: ${value}`));
  if (parts.length > 4) box.appendChild(el("span", "k", `+${parts.length - 4} more`));
  return box;
}

function ruleCard(rule: EditorRule, index: number): HTMLElement {
  const vocabulary = state.policy?.vocabulary;
  const open = rule._open === true;
  const card = el("div", `rule${open ? "" : " collapsed"}`);

  const head = el("div", "rule-head");

  // Collapsed by default: eight rules with every field on screen is a wall, and what a
  // reader wants first is the order and what each one matches.
  const chevron = el("button", "chev", open ? "▾" : "▸");
  chevron.title = open ? "Collapse" : "Expand";
  chevron.setAttribute("aria-expanded", String(open));
  chevron.addEventListener("click", () => {
    rule._open = !open;
    renderEditor();
  });
  head.appendChild(chevron);
  head.appendChild(el("span", "ord", index + 1));

  const id = textInput(rule.id, "rule-id", (value) => {
    rule.id = value ?? "";
    markDirty();
  }, true);
  id.setAttribute("aria-label", "Rule id");
  head.appendChild(id);

  if (open) {
    const action = el("select");
    action.setAttribute("aria-label", "Action");
    for (const name of vocabulary?.actions ?? []) {
      const option = el("option", null, name);
      option.value = name;
      if (name === rule.action) option.selected = true;
      action.appendChild(option);
    }
    action.addEventListener("change", () => {
      rule.action = action.value;
      rule.params = {};
      markDirty();
      renderEditor();
    });
    head.appendChild(action);
  } else {
    head.appendChild(matchSummary(rule));
    head.appendChild(el("span", `act-pill ${actionKind(rule.action)}`, rule.action));
  }

  const up = el("button", "icon", "↑");
  up.title = "Move earlier — the first matching rule wins";
  up.addEventListener("click", () => moveRule(index, -1));
  const down = el("button", "icon", "↓");
  down.title = "Move later";
  down.addEventListener("click", () => moveRule(index, 1));
  const remove = el("button", "icon danger", "Remove");
  remove.addEventListener("click", () => {
    state.editorRules.splice(index, 1);
    markDirty();
    renderEditor();
  });
  head.appendChild(up);
  head.appendChild(down);
  head.appendChild(remove);
  card.appendChild(head);

  if (!open) return card;

  const body = el("div", "rule-body");
  rule.match = rule.match ?? {};
  const match = rule.match;

  body.appendChild(field("Verdict", chipSelect(vocabulary?.verdicts ?? [], match["verdict"], (value) => { match["verdict"] = value; markDirty(); })));
  body.appendChild(field("Bot class", chipSelect(vocabulary?.botClasses ?? [], match["botClass"], (value) => { match["botClass"] = value; markDirty(); })));
  body.appendChild(field("Category", chipSelect(vocabulary?.categories ?? [], match["category"], (value) => { match["category"] = value; markDirty(); })));
  body.appendChild(field("Detector", chipSelect(vocabulary?.detectors ?? [], match["detector"], (value) => { match["detector"] = value; markDirty(); })));
  body.appendChild(field("Method", chipSelect(vocabulary?.methods ?? [], match["method"], (value) => { match["method"] = value; markDirty(); })));

  body.appendChild(
    field(
      "Evidence",
      segmented<boolean | undefined>(
        [
          ["any", undefined],
          ["proven", true],
          ["unproven", false],
        ],
        match["certain"] as boolean | undefined,
        (value) => {
          match["certain"] = value;
          markDirty();
        },
      ),
      "proven means at least one piece of certain evidence — including a proven human",
    ),
  );

  body.appendChild(
    field("Score", [
      numberInput(match["minScore"], "min", (value) => { match["minScore"] = value; markDirty(); }),
      el("span", "hint", "to"),
      numberInput(match["maxScore"], "max", (value) => { match["maxScore"] = value; markDirty(); }),
    ]),
  );

  body.appendChild(field("Identity", listInput(match["identity"], "googlebot, gptbot", (value) => { match["identity"] = value; markDirty(); })));
  body.appendChild(field("Path", listInput(match["path"], "/api/, /search", (value) => { match["path"] = value; markDirty(); }), "a string matches as a prefix"));
  body.appendChild(
    field(
      "Prior bots",
      numberInput(match["minPriorConfirmations"], "0", (value) => { match["minPriorConfirmations"] = value; markDirty(); }),
      "times this actor was already proven a bot",
    ),
  );
  body.appendChild(
    field(
      "Unsolved",
      numberInput(match["minUnsolvedChallenges"], "0", (value) => { match["minUnsolvedChallenges"] = value; markDirty(); }),
      "challenges issued to this actor that were never answered — solving one clears the count",
    ),
  );

  rule.params = rule.params ?? {};
  const params = rule.params;
  for (const node of paramFields(rule.action, params)) body.appendChild(node);

  body.appendChild(field("Reason", textInput(rule.reason, "shown in the decision and in your logs", (value) => { rule.reason = value ?? ""; markDirty(); })));

  card.appendChild(body);
  return card;
}

function paramFields(action: string, params: Record<string, unknown>): HTMLElement[] {
  switch (action) {
    case "block":
      return [
        field("Status", numberInput(params["status"], "403", (value) => { params["status"] = value; markDirty(); })),
        field("Body", textInput(params["body"], "Automated traffic is not served here.", (value) => { params["body"] = value; markDirty(); })),
      ];
    case "redirect":
      return [field("Location", textInput(params["location"], "/too-fast", (value) => { params["location"] = value; markDirty(); }, true))];
    case "delay":
      return [field("Delay", numberInput(params["delayMs"], "250", (value) => { params["delayMs"] = value; markDirty(); }), "milliseconds")];
    case "rate-limit": {
      const limit = (params["limit"] ?? {}) as Record<string, unknown>;
      params["limit"] = limit;
      return [
        field("Limit", [
          numberInput(limit["max"], "60", (value) => { limit["max"] = value; markDirty(); }),
          el("span", "hint", "requests per"),
          numberInput(limit["windowMs"], "60000", (value) => { limit["windowMs"] = value; markDirty(); }),
          el("span", "hint", "ms"),
        ]),
      ];
    }
    case "custom":
      return [field("Handler", textInput(params["handler"], "handler-id", (value) => { params["handler"] = value; markDirty(); }, true), "id of a handler you registered")];
    default:
      return [];
  }
}

function lockedCard(row: { id: string; index: number }): HTMLElement {
  const card = el("div", "rule locked");
  const head = el("div", "rule-head");
  head.appendChild(el("span", "ord", `#${row.index + 1}`));
  head.appendChild(el("span", "mono", row.id));
  head.appendChild(el("span", "grow"));
  head.appendChild(el("span", "pill", "predicate — locked"));
  card.appendChild(head);
  card.appendChild(
    el("div", "rule-body", "This rule matches with a function, which cannot be represented here or sent over HTTP. It stays exactly as it is, at this position, whatever else you change."),
  );
  return card;
}

function moveRule(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= state.editorRules.length) return;
  const moved = state.editorRules.splice(index, 1)[0];
  if (moved === undefined) return;
  state.editorRules.splice(target, 0, moved);
  markDirty();
  renderEditor();
}

function renderEditor(): void {
  if (!SECTIONS.policy) return;
  const list = $("rulelist");
  clear(list);
  const locked = (state.policy?.rules ?? []).filter((row) => !row.editable);

  if (state.editorRules.length === 0 && locked.length === 0) {
    list.appendChild(el("div", "note", "No rules. Every request takes the default action — add one, or import a set."));
  }

  // Locked rules are drawn at the index they hold, because that is where the server
  // will splice them back in and therefore what decides whether they run first.
  const rendered: HTMLElement[] = state.editorRules.map((rule, index) => ruleCard(rule, index));
  for (const row of locked) rendered.splice(Math.min(row.index, rendered.length), 0, lockedCard(row));
  for (const node of rendered) list.appendChild(node);

  if (state.editorMode === "json") byId<HTMLTextAreaElement>("policy-json").value = JSON.stringify(cleanRules(state.editorRules), null, 2);
}

export function drawPolicyTab(): void {
  const document_ = state.policy;
  if (document_ === undefined) return;

  const editable = document_.editable;
  $("policy-apply").hidden = !editable;
  byId<HTMLTextAreaElement>("policy-json").readOnly = !editable;
  $("policy-mode").textContent = editable ? "editable" : "read-only";
  $("rule-add").hidden = !editable;
  $("policy-import").hidden = !editable;

  const preserved = document_.rules.filter((row) => !row.editable);
  let note = editable ? "First match wins — order matters." : "Read-only. Enable controls.editPolicy to change these.";
  if (preserved.length > 0) note += ` ${preserved.length} rule(s) use a predicate function and are locked.`;
  $("policy-note").textContent = note;

  renderPresetButtons();
  drawGuard();
  drawRanges();

  if (SECTIONS.robots) {
    $("robots-preview").textContent = document_.robots === "" ? "(this policy declines no crawler by name)" : document_.robots;
    const notes = $("robots-notes");
    clear(notes);
    for (const note_ of document_.robotsNotes) notes.appendChild(el("div", "ev-meta", `${note_.rule}: ${note_.reason}`));
  }

  const rules = $("stat-rules");
  clear(rules);
  const installed = state.snapshot?.rules ?? [];
  if (installed.length === 0) rules.appendChild(el("div", "note", "No rules configured — every request takes the default action."));
  else installed.forEach((rule, index) => rules.appendChild(el("span", "chip", `${index + 1}. ${rule}`)));
}

/**
 * Starts a rule from a request the operator was looking at.
 *
 * Appended, expanded, and previewed straight away — the three things somebody would
 * otherwise do by hand between noticing an actor and having a rule they can judge.
 * Nothing is applied: this fills the editor, exactly like an import.
 *
 * It loads the policy document first, and that `await` is load-bearing rather than
 * tidy. Drafting is reachable from the Live tab, which somebody can use for an hour
 * without ever opening the Policy one — and appending to an editor that has not been
 * filled yet leaves it holding the draft *and nothing else*, while marking it dirty so
 * the load that follows will not correct it. Apply that and the running policy becomes
 * one drafted rule.
 */
export async function draftIntoEditor(entry: DashboardEntry): Promise<void> {
  if (state.policy === undefined) await loadPolicy();
  const drafted = draftRule(entry, state.editorRules.map((rule) => rule.id));
  state.editorRules.push(drafted.rule);
  markDirty();
  if (state.editorMode === "json") byId<HTMLTextAreaElement>("policy-json").value = JSON.stringify(cleanRules(state.editorRules), null, 2);
  renderEditor();
  app.showTab("policy");

  const notes = [
    `Drafted “${drafted.rule.id}”, tagging only. Nothing is applied — read it, choose the action, then apply.`,
    drafted.because,
    "It was added last, which is the only position that cannot change what an existing rule does. Move it up with ↑ if it needs to win.",
  ];
  // Said immediately, because the preview is a round trip and an empty box in the
  // meantime reads as nothing having happened.
  showResult("warn", (box) => {
    for (const note of notes) box.appendChild(el("div", note === notes[0] ? null : "ev-meta", note));
  });
  toast("ok", "Rule drafted", "In the editor, tagging only, not applied.");
  await runPreview(notes);
}

// ---- mode switch, add, expand ----------------------------------------------

function switchToGui(): void {
  if (state.editorMode === "gui") return;
  const parsed = editorRules();
  if (parsed.error !== undefined) {
    toast("bad", "That JSON will not parse", parsed.error);
    return;
  }
  state.editorRules = parsed.rules ?? [];
  state.editorMode = "gui";
  $("mode-gui").setAttribute("aria-pressed", "true");
  $("mode-json").setAttribute("aria-pressed", "false");
  $("editor-gui").hidden = false;
  $("editor-json").hidden = true;
  renderEditor();
}

function switchToJson(): void {
  state.editorMode = "json";
  $("mode-gui").setAttribute("aria-pressed", "false");
  $("mode-json").setAttribute("aria-pressed", "true");
  $("editor-gui").hidden = true;
  $("editor-json").hidden = false;
  byId<HTMLTextAreaElement>("policy-json").value = JSON.stringify(cleanRules(state.editorRules), null, 2);
}

// ---- import and export ------------------------------------------------------

async function exportSettings(): Promise<void> {
  // The whole settings document, not just the rules: a file that records the detectors,
  // ranges and guard alongside them is the one you want when comparing two deployments
  // six months from now. Only the rules half is importable, and the file says so.
  try {
    const response = await fetch(`${API}/api/settings`);
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    download(text, `bothandler-settings-${today()}.json`, "application/json");
    toast("ok", "Settings exported", "Rules, plus a record of the configuration around them.");
  } catch (error) {
    toast("bad", "Export failed", String(error));
  }
}

function readSettingsFile(file: File): void {
  const reader = new FileReader();
  reader.onload = (): void => {
    try {
      applyImported(JSON.parse(String(reader.result)) as Record<string, unknown>, file.name);
    } catch (error) {
      toast("bad", "That file is not JSON", String(error));
    }
  };
  reader.onerror = (): void => toast("bad", "Could not read that file", "");
  reader.readAsText(file);
}

/**
 * Loads a file into the editor — and only into the editor.
 *
 * Nothing is applied: an import that took effect on drop would be a policy change made
 * by a mis-drag. What it does is fill the editor and say what it ignored, so the next
 * step is the same Preview and Apply as any other edit.
 */
function applyImported(document_: Record<string, unknown> | unknown[], name: string): void {
  const rules = Array.isArray(document_)
    ? (document_ as EditorRule[])
    : Array.isArray((document_ as { rules?: unknown }).rules)
      ? ((document_ as { rules: EditorRule[] }).rules)
      : undefined;
  if (rules === undefined) {
    toast("bad", "Nothing to import", "Expected an array of rules, or a settings file with a rules array.");
    return;
  }
  setEditorRules(rules);
  markDirty();
  switchToGui();

  const ignored: string[] = [];
  const readOnly = (document_ as { readOnly?: { lockedRules?: unknown[] } }).readOnly;
  if (readOnly !== undefined) {
    ignored.push("the guard, the detectors, the ranges and the audit — those come from the code that built the handler, not from a file");
    if (Array.isArray(readOnly.lockedRules) && readOnly.lockedRules.length > 0) {
      ignored.push(`${readOnly.lockedRules.length} predicate rule(s), which stay as they are`);
    }
  }
  showResult("warn", (box) => {
    box.appendChild(el("div", null, `Loaded ${rules.length} rule(s) from ${name}. Nothing has been applied yet — preview it first.`));
    for (const line of ignored) box.appendChild(el("div", "ev-meta", `Ignored: ${line}`));
  });
  toast("ok", `Imported ${rules.length} rule(s)`, "Review, preview, then apply.");
}

// ---- preview and apply ------------------------------------------------------

function collectForSubmit(): Array<Record<string, unknown>> | undefined {
  const parsed = editorRules();
  if (parsed.error !== undefined) {
    showResult("bad", (box) => box.appendChild(el("div", null, parsed.error ?? "")));
    toast("bad", "That JSON will not parse", parsed.error);
    return undefined;
  }
  const cleaned = cleanRules(parsed.rules ?? []);
  const blank = cleaned.filter((rule) => rule["id"] === undefined || rule["id"] === "").length;
  if (blank > 0) {
    toast("bad", "Every rule needs an id", "It is what every decision and log line names.");
    return undefined;
  }
  return cleaned;
}

async function runPreview(notes: readonly string[] = []): Promise<void> {
  const rules = collectForSubmit();
  if (rules === undefined) return;
  const result = await postJson<Preview & { error?: string }>("/api/policy/preview", { rules });
  if (!result.ok) {
    showResult("bad", (box) => box.appendChild(el("div", null, result.error ?? "")));
    toast("bad", "Refused", result.error ?? "");
    return;
  }
  renderPreview(result.data, notes);
}

async function applyPolicy(): Promise<void> {
  const rules = collectForSubmit();
  if (rules === undefined) return;
  const result = await postJson<{ rules: number; warnings?: string[]; error?: string }>("/api/policy/apply", { rules });
  if (!result.ok) {
    showResult("bad", (box) => box.appendChild(el("div", null, result.error ?? "")));
    toast("bad", "Refused", result.error ?? "");
    return;
  }
  state.editorDirty = false;
  $("policy-dirty").hidden = true;
  await loadPolicy();
  toast("ok", "Applied", `${n(result.data.rules)} rule(s) now in force.`);
  showResult("ok", (box) => {
    box.appendChild(el("div", null, `Applied. ${n(result.data.rules)} rule(s) are now in force.`));
    for (const warning of result.data.warnings ?? []) box.appendChild(el("div", "ev-meta", warning));
  });
}

/** Built from the registry the server sends, so a new preset appears here on its own. */
function renderPresetButtons(): void {
  const box = $("preset-buttons");
  const presets = state.policy?.vocabulary.presets ?? [];
  if (box.childElementCount === presets.length) return;
  clear(box);
  for (const preset of presets) {
    const button = el("button", null, preset);
    button.addEventListener("click", () => {
      void (async () => {
        const result = await postJson<Preview & { error?: string }>("/api/policy/preview", { preset });
        if (!result.ok) {
          toast("bad", "Refused", result.error ?? "");
          return;
        }
        renderPreview(result.data);
      })();
    });
    box.appendChild(button);
  }
}

export function initPolicy(): void {
  if (!SECTIONS.policy) return;
  $("mode-gui").addEventListener("click", switchToGui);
  $("mode-json").addEventListener("click", switchToJson);

  $("rule-add").addEventListener("click", () => {
    state.editorRules.push({ id: `new-rule-${state.editorRules.length + 1}`, match: {}, action: "tag", params: {}, _open: true });
    markDirty();
    renderEditor();
  });

  $("rule-expand").addEventListener("click", () => {
    const anyClosed = state.editorRules.some((rule) => rule._open !== true);
    for (const rule of state.editorRules) rule._open = anyClosed;
    $("rule-expand").textContent = anyClosed ? "Collapse all" : "Expand all";
    renderEditor();
  });

  byId<HTMLTextAreaElement>("policy-json").addEventListener("input", markDirty);
  $("policy-preview").addEventListener("click", () => void runPreview());
  $("policy-apply").addEventListener("click", () => void applyPolicy());
  $("policy-revert").addEventListener("click", () => {
    state.editorDirty = false;
    $("policy-dirty").hidden = true;
    $("policy-result").hidden = true;
    resetGuardDraft();
    void loadPolicy();
  });

  $("policy-export").addEventListener("click", () => void exportSettings());
  $("policy-import").addEventListener("click", () => byId<HTMLInputElement>("policy-file").click());
  byId<HTMLInputElement>("policy-file").addEventListener("change", () => {
    const input = byId<HTMLInputElement>("policy-file");
    const file = input.files?.[0];
    if (file !== undefined) readSettingsFile(file);
    input.value = "";
  });

  const panel = $("editor-panel");
  for (const name of ["dragenter", "dragover"]) {
    panel.addEventListener(name, (event) => {
      if (state.policy?.editable !== true) return;
      event.preventDefault();
      panel.classList.add("drop");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    panel.addEventListener(name, (event) => {
      panel.classList.remove("drop");
      if (name !== "drop") return;
      event.preventDefault();
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file !== undefined) readSettingsFile(file);
    });
  }
}
