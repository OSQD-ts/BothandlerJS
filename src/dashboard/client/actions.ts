import { clear, el } from "./dom.js";
import { BOOT } from "./boot.js";
import { postJson } from "./api.js";
import { toast } from "./app.js";
import { state } from "./store.js";

/**
 * The three things you can do to one client, rather than to a class of request.
 *
 * Shared by the actor drill-down and the Actors screen, which offer the same three and
 * would otherwise offer them slightly differently.
 *
 * Allowlisting is the consequential one and it is the one that asks twice. **An
 * allowlisted address is not judged leniently; it is not judged at all** — detection
 * does not run, no evidence is produced, no rule sees it — so the button states the
 * address it is about to exempt and waits for a second click. That is deliberately not
 * a dialog: a confirmation you can dismiss without reading is a click with extra steps,
 * whereas a button that changes into the sentence it is about to enact has to be read
 * to be pressed.
 */
export type AfterAction = () => void;

/**
 * How many controls in the Actors table are mid-interaction right now.
 *
 * The Actors screen repaints on every counters frame — every two seconds — and a repaint
 * builds new buttons. An operator who clicked "Allowlist", read the address it offered
 * back and reached for the second click could therefore have the button quietly reset
 * under their cursor, so that the second click armed it again instead of doing anything.
 * Which is the worst outcome available for a confirmation: it teaches people that the
 * first click does nothing and the way through is to click twice, quickly.
 *
 * The open label editor counts for the same reason and is the worse case of the two: a
 * repaint does not merely reset it, it removes the input and takes whatever had been
 * typed with it, on a timer, while somebody is still typing. That is why this counter is
 * about interaction rather than about confirmation specifically.
 *
 * So the list holds still while somebody is deciding. See `drawActors`.
 */
let armed = 0;

export function isConfirming(): boolean {
  return armed > 0;
}

export function actorActions(key: string, after: AfterAction, current?: string): HTMLElement[] {
  if (!BOOT.allowActing) return [];

  const forget = el("button", null, "Forget");
  forget.title = "Discard this actor's history — the cure for a false positive that has stuck";
  forget.addEventListener("click", () => {
    void act({ key, action: "forget" }, `Forgot ${key}`, "Its next request is assessed as a first request.", after);
  });

  const clear = el("button", null, "Clear as human");
  clear.title = "Grant this actor human clearance for an hour, as though it had solved a challenge";
  clear.addEventListener("click", () => {
    void act({ key, action: "clear", forMs: 60 * 60_000 }, `Cleared ${key}`, "Held as human for an hour, then reassessed.", after);
  });

  // A name is a note, and nothing in detection reads it. A label can also carry two
  // switches, and those are not notes — which is why they are opt-in inside the editor
  // rather than being what the button does.
  const label = labelControl(key, current, state.labelSwitches.get(key), after);

  return [confirmingButton("Allowlist", `Allowlist ${key} — it stops being assessed at all`, () => allowlist(key, after)), forget, clear, label];
}

/**
 * The Label control: a button that becomes a text box, a Save and a Cancel in place.
 *
 * It used to call `prompt()`, which is the smallest amount of code that could possibly
 * work and does not work here. A sandboxed iframe blocks `prompt()` outright, and the
 * dashboard is embeddable — so on an embedded page the button did nothing at all, with
 * no error and no way to tell. Editing in place also keeps the actor's own row on screen
 * while you name it, which is the row you are naming it after.
 */
/** A checkbox with its words, for the editor's second line. */
function option(text: string, checked: boolean, title: string): { label: HTMLLabelElement; box: HTMLInputElement } {
  const label = el("label", "label-option") as HTMLLabelElement;
  const box = el("input") as HTMLInputElement;
  box.type = "checkbox";
  box.checked = checked;
  label.title = title;
  label.append(box, document.createTextNode(` ${text}`));
  return { label, box };
}

function labelControl(key: string, current: string | undefined, switches: { hide?: true; skip?: true } | undefined, after: AfterAction): HTMLElement {
  const host = el("span", "label-edit");
  const tags = [switches?.hide === true ? "hidden" : "", switches?.skip === true ? "not analysed" : ""].filter((tag) => tag !== "");
  const button = el("button", null, current === undefined ? "Label" : "Relabel");
  button.title =
    tags.length === 0
      ? "Give this actor a name, for whoever reads this next. A name on its own never changes a verdict."
      : `Named "${current ?? ""}", ${tags.join(" and ")}. Change the name or what it switches.`;

  const commit = (value: string, hide: boolean, skip: boolean): void => {
    const trimmed = value.trim().slice(0, 120);
    // Without a name there is no label, and so nothing for the switches to hang on. That
    // is deliberate: "why is this actor hidden?" should always have an answer on screen.
    const kept = trimmed !== "";
    const detail = !kept
      ? "It shows as its address again, and is hidden and analysed like anybody else."
      : skip
        ? `Named "${trimmed}", and not analysed from now on — the same as allowlisting it. Its requests stop appearing in the live feed; the Statistics screen counts them.`
        : hide
          ? `Shown as "${trimmed}", and kept out of the live feed. Still analysed, and still counted.`
          : `Shown as "${trimmed}" wherever it appears.`;
    void act(
      { key, action: "label", ...(kept ? { label: trimmed, hideFromFeed: hide, skipAnalysis: skip } : {}) },
      kept ? `Labelled ${key}` : `Cleared the label on ${key}`,
      detail,
      () => {
        // Applied here as well as by the next stats frame, which is two seconds away. The
        // toast says what now happens to this actor, and for those two seconds it would
        // otherwise be untrue on the very page that said it. The frame then confirms it,
        // and is what carries the change to every other dashboard.
        if (!kept) {
          state.labels.delete(key);
          state.labelSwitches.delete(key);
        } else {
          state.labels.set(key, trimmed);
          if (hide || skip) state.labelSwitches.set(key, { ...(hide ? { hide: true as const } : {}), ...(skip ? { skip: true as const } : {}) });
          else state.labelSwitches.delete(key);
        }
        after();
      },
    );
  };

  button.addEventListener("click", () => {
    // Whatever holds the row's actions: the table cell on the Actors screen, the button
    // bar in the drill-down. The editor takes it over for as long as it is open.
    const container = host.parentElement;
    clear(host);

    const input = el("input", "label-input") as HTMLInputElement;
    input.type = "text";
    input.value = current ?? "";
    input.placeholder = "A name for this client";
    input.setAttribute("aria-label", `Name for ${key}`);
    input.maxLength = 120;

    // Save and Cancel, on screen, where a `prompt()` used to put them.
    //
    // Three earlier attempts at this put the two buttons beside the row's existing four
    // and the "In feed" link. The cell does not wrap, so the row grew wider than the
    // panel and Save ended up past its right edge, underneath the page — visible and
    // impossible to click. The fix is not narrower buttons: it is that an open editor
    // has no business showing Allowlist and Forget at all. Somebody reaching for a name
    // is not reaching for those, and hiding them leaves more room than the editor needs.
    const save = el("button", "label-save", "Save");
    save.title = "Save this name";
    const cancel = el("button", null, "Cancel");
    cancel.title = "Leave the name as it was";
    // Still true, and still worth saying — the buttons are for people who do not know it.
    input.title = "Enter to save, Escape to cancel";

    // The two switches, on a line of their own under the name. Beside it they would widen
    // an editor that sits in a table cell which does not wrap, which is precisely how Save
    // ended up past the edge of the panel three times before.
    const hide = option("Hide from feed", switches?.hide === true, "Keep this actor's requests out of the live feed. They are still analysed, decided and counted, and the feed says how many it is hiding.");
    const skip = option(
      "Don't analyse",
      switches?.skip === true,
      "Do not analyse this actor at all — the same as allowlisting it. Nothing that arrives under this key is judged, and like allowlisted traffic it does not appear in the live feed; the Statistics screen counts it.",
    );
    // Said in words the moment it is ticked, rather than only in a tooltip. Switching
    // analysis off is allowlisting by another name, and the allowlist button makes you
    // read what it is about to do before it does it; this is the same courtesy.
    const warning = el("span", "label-warn", "Not judged at all, and gone from the live feed — the same as allowlisting this actor.");
    warning.hidden = !skip.box.checked;
    skip.box.addEventListener("change", () => {
      warning.hidden = !skip.box.checked;
    });
    const options = el("span", "label-options");
    options.append(hide.label, skip.label, warning);

    // The table must not repaint this editor out from under the person using it.
    armed++;
    container?.classList.add("editing");

    let settled = false;
    const finish = (accept: boolean): void => {
      if (settled) return;
      settled = true;
      armed--;
      container?.classList.remove("editing");
      if (accept) commit(input.value, hide.box.checked, skip.box.checked);
      // Restoring the button is only right when nothing was saved: a save repaints the
      // whole table from the server, and touching a detached node would be a no-op that
      // looks like a bug the next time somebody reads this.
      else {
        clear(host);
        host.appendChild(button);
      }
    };

    for (const control of [input, save, cancel, hide.box, skip.box]) {
      control.addEventListener("keydown", (event) => {
        const pressed = (event as KeyboardEvent).key;
        if (pressed === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (pressed === "Enter" && control === input) {
          event.preventDefault();
          finish(true);
        }
      });
    }

    // A press inside the editor must not blur the input on its way to the click, because
    // a blur is a cancel and the cancel would land first. `mousedown` rather than
    // `pointerdown`: an earlier version used the latter, which does not fire at all when
    // a button is activated from the keyboard — so Save worked with a mouse and silently
    // did nothing with Tab and Enter.
    // The checkboxes and their words need it too: a browser that does not focus a checkbox
    // on click reports the blur with nowhere to go, which reads as clicking away.
    for (const control of [save, cancel, hide.label, skip.label]) control.addEventListener("mousedown", (event) => event.preventDefault());
    save.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));

    // Clicking away is a cancel rather than a save. Naming something is deliberate, and
    // a stray click should not commit a half-typed name — but tabbing from the box to
    // Save is not clicking away, which is what `relatedTarget` is here to tell apart.
    host.addEventListener("focusout", (event) => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (next !== null && host.contains(next)) return;
      finish(false);
    });

    const line = el("span", "label-line");
    line.append(input, save, cancel);
    host.append(line, options);
    input.focus();
    input.select();
  });

  host.appendChild(button);
  return host;
}

/**
 * A button that has to be pressed twice, and says what it will do in between.
 *
 * Reverts after a few seconds, so a half-pressed destructive action does not sit there
 * waiting for an accidental second click.
 */
function confirmingButton(label: string, confirmation: string, run: () => void): HTMLButtonElement {
  const button = el("button", "danger", label);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (!pending) return;
    pending = false;
    armed--;
    button.textContent = label;
    button.className = "danger";
  };

  button.addEventListener("click", () => {
    if (pending) {
      if (timer !== undefined) clearTimeout(timer);
      disarm();
      run();
      return;
    }
    pending = true;
    armed++;
    button.textContent = confirmation;
    button.className = "danger primary";
    timer = setTimeout(disarm, 5000);
  });
  return button;
}

async function allowlist(key: string, after: AfterAction): Promise<void> {
  const result = await postJson<{ entries?: string[]; error?: string }>("/api/ranges", { name: "allowlist", add: [key] });
  if (!result.ok) {
    toast("bad", "Not allowlisted", result.error ?? "");
    return;
  }
  toast("warn", `Allowlisted ${key}`, "Requests from it are no longer assessed at all.");
  after();
}

async function act(body: { key: string; action: string; forMs?: number; label?: string }, title: string, detail: string, after: AfterAction): Promise<void> {
  const result = await postJson<{ error?: string }>("/api/actor", body);
  if (!result.ok) {
    toast("bad", "Refused", result.error ?? "");
    return;
  }
  toast("ok", title, detail);
  after();
}
