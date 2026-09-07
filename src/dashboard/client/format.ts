/** Number, duration and window formatting. Pure, so the awkward cases can be tested. */

const numbers = new Intl.NumberFormat();

export function n(value: number | undefined): string {
  return numbers.format(value ?? 0);
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export function ms(value: number): string {
  return value >= 10 ? `${value.toFixed(1)}ms` : `${value.toFixed(2)}ms`;
}

export function uptime(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function rangeLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)}h`;
}

/** Wall-clock time for a feed row. Local, seconds included, because a feed moves in seconds. */
/**
 * A time, always as 24-hour HH:MM:SS.
 *
 * Built from the local components rather than handed to `toLocaleTimeString`, which
 * answers in whatever the viewer's locale prefers — so the same feed read "4:40:46 PM" on
 * one operator's screen and "16:40:46" on the next, and a dashboard two people look at
 * together should not disagree with itself about what time it is. Local time, not UTC:
 * this is the clock on the wall next to the server somebody is watching.
 */
export function clockTime(at: number): string {
  const when = new Date(at);
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/** A date, always as DD-MM-YYYY. */
export function clockDate(at: number): string {
  const when = new Date(at);
  return `${pad(when.getDate())}-${pad(when.getMonth() + 1)}-${when.getFullYear()}`;
}

/**
 * Both, for the places where the time alone is ambiguous.
 *
 * An actor's first sighting can be days back, and "first seen 09:14:02" invites the reader
 * to assume it was this morning.
 */
export function clockStamp(at: number): string {
  return `${clockDate(at)} ${clockTime(at)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * What "this window" actually holds, said out loud.
 *
 * Half the panels on the Statistics screen count the retained ring and half count
 * since the process started, and until now both wore the same quiet grey subtitle.
 * They are different populations — on a busy server the ring can be ninety seconds of
 * a three-week run — so comparing a panel from one against a panel from the other is a
 * mistake the page was inviting. Every "this window" label now says how much window
 * there is.
 */
export function windowLabel(count: number, oldestAt: number | undefined, now: number): string {
  if (count === 0) return "this window · empty";
  const span = oldestAt === undefined ? 0 : Math.max(0, now - oldestAt);
  return `last ${n(count)} requests · ${rangeLabel(span)}`;
}
