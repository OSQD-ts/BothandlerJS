import { API } from "./boot.js";
import { isEmbedded } from "./dom.js";

/**
 * The page's two ways of talking to its server.
 *
 * Every write is JSON with a JSON content type, and that is not a style choice: the
 * server refuses a body it did not get as `application/json` precisely because an HTML
 * form cannot send one, which is what stops somebody else's page from posting here
 * with an operator's credentials attached.
 */

/**
 * The token this page was opened with, if it was opened with one.
 *
 * `auth: { token }` is documented as the form to use with "a link people already hold",
 * and the server accepts the token as a `?token=` on the request. That authenticated the
 * *navigation* and nothing after it: the page loaded, every fetch it then made went to a
 * path carrying no token, and all of them were refused. What that looked like was a
 * dashboard that rendered its chrome and then sat on "reconnecting…" for ever — the one
 * failure this page is otherwise careful never to show, because it is indistinguishable
 * from a server that has gone away.
 *
 * So a page opened with a token keeps using it. Read once, at load: a token is not
 * something that changes while somebody is reading, and re-reading `location` on every
 * request would make this sensitive to a history entry written by anything else.
 *
 * Not when embedded. There the address bar belongs to the host page, and a `token` in
 * *their* query string is not ours to pick up and send anywhere — `src` is the only thing
 * that points at the handler, and `parseMount` deliberately drops a query string from it.
 */
const token = ((): string => {
  if (isEmbedded() || typeof location === "undefined") return "";
  try {
    return new URLSearchParams(location.search).get("token") ?? "";
  } catch {
    return "";
  }
})();

/** The path, plus the token it was opened with. Exported for the stream, which is an
 * `EventSource` rather than a `fetch` and would otherwise be the one request left out. */
/** The shared client modules ask for this name; `authed` is what the rest of this client calls it. */
export { authed as apiUrl };

export function authed(path: string): string {
  if (token === "") return API + path;
  const url = API + path;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(authed(path));
  if (!response.ok) throw new Error(await errorFrom(response));
  return (await response.json()) as T;
}

export interface PostResult<T> {
  ok: boolean;
  data: T;
  error?: string;
}

export async function postJson<T>(path: string, body: unknown): Promise<PostResult<T>> {
  const response = await fetch(authed(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  return response.ok ? { ok: true, data } : { ok: false, data, error: String(data.error ?? "The server refused this.") };
}

async function errorFrom(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${response.status} ${response.statusText}`;
}
