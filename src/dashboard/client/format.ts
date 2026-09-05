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
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString();
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
