import { $, clear, el, holdsTextEntry, label } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { app, toast } from "./app.js";
import { postJson } from "./api.js";
import { renderPreview, showResult } from "./result.js";
import { state } from "./store.js";
import type { Preview } from "./types.js";

/** The guard as the form holds it. The same five fields the server accepts back. */
interface GuardDraft {
  falsePositivePolicy: string;
  fallbackAction: string;
  defaultAction: string;
  terminalScoreThreshold: number;
  suspectThreshold: number;
}

let draft: GuardDraft | undefined;

/**
 * What each mode actually does, in the place somebody is about to change it.
 *
 * The words `strict`, `balanced` and `aggressive` sound like a slider from cautious to
 * effective. They are not: they are three different answers to "may a guess close the
 * door", and the third one is "yes". Anybody moving this setting should read what it
 * means without going to find the documentation, so the documentation comes to them.
 */
const MODE_NOTES: Record<string, string> = {
  strict: "A terminal action survives only on proven evidence. Nothing is ever denied on a guess. This is the default, and it is the claim this library makes about itself.",
  balanced:
    "A terminal action also survives on a probabilistic verdict that clears the score threshold with at least two independent strong signals. Real people do trip two signals — a hardened browser behind a corporate proxy is the usual pair — so this setting will eventually deny somebody who should have been served.",
  aggressive: "The guard is off. Every rule does exactly what it says, on proof or on suspicion alike, and the people it turns away first are the ones with the most unusual and most legitimate setups.",
};

export function drawGuard(): void {
  // Removed with its section, which can be off while the Policy tab as a whole is on.
  if (!SECTIONS.guard) return;
  const document_ = state.policy;
  const snapshot = state.snapshot;
  if (snapshot === undefined) return;

  const editable = document_?.guardEditable === true;
  const panel = $("stat-policy");
  // Not while somebody is part-way through changing a threshold. See `holdsTextEntry`.
  if (holdsTextEntry(panel)) return;
  clear(panel);

  if (!editable || document_ === undefined) {
    const rows: Array<[string, string]> = [
      ["False-positive policy", snapshot.policy.falsePositivePolicy],
      ["Fallback when the guard stops a rule", snapshot.policy.fallbackAction],
      ["Terminal score threshold", String(snapshot.policy.terminalScoreThreshold)],
      ["Suspect threshold", String(snapshot.policy.suspectThreshold)],
      ["Action when no rule matches", snapshot.policy.defaultAction],
      ["Challenge configured", snapshot.policy.challengeEnabled ? "yes" : "no"],
      ["Range sets", snapshot.ranges.length === 0 ? "none" : snapshot.ranges.map((range) => `${range.name} (${range.size})`).join(", ")],
    ];
    for (const [key, value] of rows) {
      const line = el("div", "stat-row");
      line.appendChild(el("span", "k", key));
      line.appendChild(el("span", "v", value));
      panel.appendChild(line);
    }
    $("guard-mode").textContent = "not editable here";
    $("guard-note").textContent =
      "These are fixed at construction on this dashboard. It can change which rules exist; it cannot change how far a rule is allowed to go, because relaxing that is the one edit that can start denying people. Enable it deliberately with controls: { editGuard: true }.";
    return;
  }

  if (draft === undefined) draft = { ...document_.guard };
  const vocabulary = document_.vocabulary;
  $("guard-mode").textContent = state.guardDirty ? "unsaved changes" : "editable";
  $("guard-note").textContent =
    "Changing these changes what every rule is allowed to do, on the next request. Preview it against the traffic in the window first — that is the only view you get of who it would start turning away.";

  panel.appendChild(
    guardField(
      // "Mode" rather than "Guard": the panel is already called that, and a field
      // repeating its own panel's name reads as a heading rather than as a control.
      "Mode",
      segmented(
        vocabulary.falsePositivePolicies.map((mode) => [mode, mode] as [string, string]),
        draft.falsePositivePolicy,
        (value) => {
          setDraft({ falsePositivePolicy: value });
          drawGuard();
        },
      ),
    ),
  );
  panel.appendChild(el("div", "note guard-explains", MODE_NOTES[draft.falsePositivePolicy] ?? ""));

  panel.appendChild(
    guardField(
      "Fallback",
      select(vocabulary.fallbackActions, draft.fallbackAction, (value) => setDraft({ fallbackAction: value })),
      "what a stopped rule becomes — the terminal actions are absent because a terminal fallback would deny the request the guard just protected",
    ),
  );
  panel.appendChild(
    guardField(
      "Default action",
      select(vocabulary.actions, draft.defaultAction, (value) => setDraft({ defaultAction: value })),
      "when no rule matches",
    ),
  );
  panel.appendChild(
    guardField(
      "Terminal score",
      number(draft.terminalScoreThreshold, (value) => setDraft({ terminalScoreThreshold: value })),
      "balanced mode only: the score a probabilistic verdict must clear",
    ),
  );
  panel.appendChild(
    guardField(
      "Suspect at",
      number(draft.suspectThreshold, (value) => setDraft({ suspectThreshold: value })),
      "the score at which a request becomes suspected-bot",
    ),
  );

  const bar = el("div", "bar-actions");
  const preview = el("button", null, "Preview");
  preview.addEventListener("click", () => {
    void previewGuard();
  });
  const apply = el("button", "primary", "Apply");
  apply.addEventListener("click", () => {
    void applyGuard();
  });
  const revert = el("button", null, "Revert");
  revert.addEventListener("click", () => {
    draft = { ...document_.guard };
    state.guardDirty = false;
    drawGuard();
  });
  bar.appendChild(preview);
  bar.appendChild(apply);
  bar.appendChild(revert);
  panel.appendChild(bar);
}

function setDraft(change: Partial<GuardDraft>): void {
  if (draft === undefined) return;
  draft = { ...draft, ...change };
  state.guardDirty = true;
  $("guard-mode").textContent = "unsaved changes";
}

/** Forgets an in-progress edit, so a reload of the policy document is reflected. */
export function resetGuardDraft(): void {
  draft = undefined;
  state.guardDirty = false;
}

/**
 * The rules a guard preview is run against.
 *
 * The *running* rules, not whatever is sitting unsaved in the editor, so the answer is
 * about the guard alone. The server splices its predicate rules back in by position, so
 * this is the policy in force.
 */
function liveRules(): unknown[] {
  return (state.policy?.rules ?? []).filter((row) => row.editable && row.rule !== undefined).map((row) => row.rule);
}

async function previewGuard(): Promise<void> {
  if (draft === undefined) return;
  const result = await postJson<Preview & { error?: string }>("/api/policy/preview", { rules: liveRules(), guard: draft });
  if (!result.ok) {
    showResult("bad", (box) => box.appendChild(el("div", null, result.error ?? "")));
    toast("bad", "Refused", result.error ?? "");
    return;
  }
  renderPreview(result.data, state.editorDirty ? ["Previewed against the rules currently in force, not the unsaved edits in the editor."] : []);
  app.showTab("policy");
}

async function applyGuard(): Promise<void> {
  if (draft === undefined) return;
  const result = await postJson<{ guard: GuardDraft; error?: string }>("/api/guard", draft);
  if (!result.ok) {
    showResult("bad", (box) => box.appendChild(el("div", null, result.error ?? "")));
    toast("bad", "Guard unchanged", result.error ?? "");
    return;
  }
  state.guardDirty = false;
  draft = { ...result.data.guard };
  if (state.policy !== undefined) state.policy.guard = { ...result.data.guard };
  toast("ok", "Guard changed", `${result.data.guard.falsePositivePolicy}, falling back to ${result.data.guard.fallbackAction}.`);
  showResult("warn", (box) => {
    box.appendChild(el("div", null, "The guard changed. It applies from the next request, and it is in the notices panel and in your logs."));
    if (result.data.guard.falsePositivePolicy !== "strict") {
      box.appendChild(
        el(
          "div",
          "ev-meta",
          "Requests can now be denied without proof. The guard-stop count is the series to watch: every stop that no longer happens is a request that used to be recoverable and is not any more.",
        ),
      );
    }
  });
  app.draw();
}

function guardField(name: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el("div", "field");
  row.appendChild(label(name, control));
  const right = el("div", "field-row");
  right.appendChild(control);
  if (hint !== undefined) right.appendChild(el("span", "hint", hint));
  row.appendChild(right);
  return row;
}

function segmented(options: Array<[string, string]>, value: string, onChange: (value: string) => void): HTMLElement {
  const box = el("div", "seg");
  for (const [label, option] of options) {
    const button = el("button", null, label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(option === value));
    button.addEventListener("click", () => onChange(option));
    box.appendChild(button);
  }
  return box;
}

function select(options: readonly string[], value: string, onChange: (value: string) => void): HTMLElement {
  const node = el("select");
  for (const option of options) {
    const item = el("option", null, option);
    item.value = option;
    if (option === value) item.selected = true;
    node.appendChild(item);
  }
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

function number(value: number, onChange: (value: number) => void): HTMLElement {
  const input = el("input");
  input.type = "number";
  input.min = "1";
  input.max = "100";
  input.value = String(value);
  input.addEventListener("input", () => {
    if (input.value !== "") onChange(Number(input.value));
  });
  return input;
}
