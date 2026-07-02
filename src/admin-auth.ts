// Shared operator-admin auth — used by every per-game admin surface (Bracket Battle,
// Know Her Game, and future unified /admin tabs). Extracted from bracket-engine so a
// single implementation gates them all.
//
// A GET page navigation authenticates via HTTP Basic (the browser's native password
// prompt — username ignored, password = the key), so once the browser has the credential
// it auto-attaches the same Authorization header to the page's same-origin fetch() calls.
// The `x-admin-key` header is also accepted so curl/scripts work unchanged.

/** True when the request carries the admin key — either as HTTP Basic auth (password = key,
 *  username ignored) or the `x-admin-key` header. False if no key is configured. */
export function adminAuthed(request: Request, key: string | undefined): boolean {
  if (!key) return false;
  if (request.headers.get("x-admin-key") === key) return true;
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!m) return false;
  let decoded = "";
  try {
    decoded = atob(m[1].trim());
  } catch {
    return false;
  }
  return decoded.slice(decoded.indexOf(":") + 1) === key; // "user:pass" → compare pass
}

/** WWW-Authenticate value for a given realm — a 401 with this triggers the browser's
 *  native password dialog (and re-prompts on a stale credential). */
export function adminRealm(realm: string): string {
  return `Basic realm="${realm}", charset="UTF-8"`;
}
