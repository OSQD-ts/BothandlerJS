/** Number, duration and window formatting. Pure, so the awkward cases can be tested. */

const numbers = new Intl.NumberFormat();

/** The shared client modules ask for this name. */
export { n as fmtInt };

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

/**
 * What the feed's header says, now that the count and the entries are different things.
 *
 * It used to read "last 693 requests · 141h", where 693 was how many entries this browser
 * was holding and 141h was how far back the oldest of them reached. Both true, and
 * together an invitation to conclude that 693 requests had arrived in 141 hours — which on
 * any busy origin is wrong by orders of magnitude, because the ring had been evicting the
 * whole time.
 *
 * So the window total leads, and it comes from the server's counters rather than from this
 * page's rows. The other two numbers appear only when they say something the first does
 * not: how many match the query box, and how many entries are actually held. A filtered
 * count is always described as a count over what is loaded, because that is what it is —
 * the query language runs in this browser and the server has never seen it.
 */
export function feedCountLabel(input: { total: number | undefined; loaded: number; matching: number; filtered: boolean }): { text: string; title: string } {
  const { loaded, matching, filtered } = input;
  // No answer from the server yet. Fall back to what this page can see, and say that is
  // what it is rather than passing it off as the window.
  if (input.total === undefined) {
    return filtered
      ? { text: `${n(matching)} of ${n(loaded)} loaded`, title: "Counting what this page has loaded. The window total has not arrived from the server yet." }
      : { text: `${n(loaded)} loaded`, title: "Counting what this page has loaded. The window total has not arrived from the server yet." };
  }
  const total = input.total;
  const partial = loaded < total;
  if (!filtered) {
    return {
      text: partial ? `${n(total)} requests · ${n(loaded)} loaded` : `${n(total)} requests`,
      title: partial
        ? `${n(total)} requests happened in this window. ${n(loaded)} of them are on this page; the rest are fetched as you page through them, and some may be past the retention and gone.`
        : `${n(total)} requests happened in this window, and all of them are on this page.`,
    };
  }
  return {
    text: partial ? `${n(matching)} of ${n(loaded)} loaded · ${n(total)} in window` : `${n(matching)} of ${n(total)}`,
    title: partial
      ? `Your filter matches ${n(matching)} of the ${n(loaded)} requests this page has loaded. ${n(total)} requests happened in the window; the filter runs in this browser, so it can only speak for what has been loaded.`
      : `Your filter matches ${n(matching)} of the ${n(total)} requests in this window, all of which are loaded.`,
  };
}
