import { el } from "./dom.js";
import { BOOT } from "./boot.js";
import { postJson } from "./api.js";
import { toast } from "./app.js";

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
 * How many confirmations are half-pressed right now.
 *
 * The Actors screen repaints on every counters frame — every two seconds — and a repaint
 * builds new buttons. An operator who clicked "Allowlist", read the address it offered
 * back and reached for the second click could therefore have the button quietly reset
 * under their cursor, so that the second click armed it again instead of doing anything.
 * Which is the worst outcome available for a confirmation: it teaches people that the
 * first click does nothing and the way through is to click twice, quickly.
 *
 * So the list holds still while somebody is deciding. See `drawActors`.
 */
let armed = 0;

export function isConfirming(): boolean {
  return armed > 0;
}

export function actorActions(key: string, after: AfterAction): HTMLElement[] {
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

  return [confirmingButton("Allowlist", `Allowlist ${key} — it stops being assessed at all`, () => allowlist(key, after)), forget, clear];
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

async function act(body: { key: string; action: string; forMs?: number }, title: string, detail: string, after: AfterAction): Promise<void> {
  const result = await postJson<{ error?: string }>("/api/actor", body);
  if (!result.ok) {
    toast("bad", "Refused", result.error ?? "");
    return;
  }
  toast("ok", title, detail);
  after();
}
