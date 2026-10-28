/**
 * Request checks for Agent Flow's loopback HTTP servers: the hook server, the
 * standalone app server and the dev relay.
 *
 * Kept free of `vscode` so scripts/ and app/ can share it.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not web pages open in the
 * user's browser: a page can POST to a loopback port without a CORS preflight,
 * and DNS rebinding lets a page on an attacker's domain read responses from one.
 */

import type { IncomingHttpHeaders } from 'http'

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

/**
 * True if `host` (the request's Host header) is a loopback name.
 *
 * A DNS-rebinding request reaches 127.0.0.1 but still carries the attacker's
 * hostname in Host, so rejecting anything else closes that hole. The port is
 * not checked: it adds nothing against rebinding, and an SSH tunnel such as
 * `-L 8080:127.0.0.1:3001` legitimately arrives as `localhost:8080`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === 'string' && LOOPBACK_HOST_RE.test(host)
}

/**
 * True if a request to the hook server can have come from hook.js (or a legacy
 * Claude Code HTTP hook), not from a web page.
 *
 * Both post with a Node HTTP client, which never sends Origin. Browsers send
 * Origin on every POST, same-origin or not, so its presence means a page made
 * the request.
 */
export function isAllowedHookRequest(headers: IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) { return false }
  return isLoopbackHost(headers.host)
}
