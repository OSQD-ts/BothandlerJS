import { API } from "./boot.js";

/**
 * The page's two ways of talking to its server.
 *
 * Every write is JSON with a JSON content type, and that is not a style choice: the
 * server refuses a body it did not get as `application/json` precisely because an HTML
 * form cannot send one, which is what stops somebody else's page from posting here
 * with an operator's credentials attached.
 */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(API + path);
  if (!response.ok) throw new Error(await errorFrom(response));
  return (await response.json()) as T;
}

export interface PostResult<T> {
  ok: boolean;
  data: T;
  error?: string;
}

export async function postJson<T>(path: string, body: unknown): Promise<PostResult<T>> {
  const response = await fetch(API + path, {
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
