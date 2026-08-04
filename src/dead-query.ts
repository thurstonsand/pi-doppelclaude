// Failures that mean the Claude Code query died out from under the turn, rather
// than the model or the request going wrong. Shared by the runtime, which retries
// them once against a fresh subprocess, and the stream, which labels the ones that
// survive that retry.

/** The Agent SDK's generic rejection from `performCleanup`: a query torn down with
 *  control requests still pending and no more specific error to give them. */
const QUERY_CLOSED = /Query closed before response received/i;

/** Anthropic rotates OAuth refresh tokens, and a Claude Code process that loses the
 *  race presents a stale one; the server then revokes the family. A sibling process
 *  has usually already refreshed successfully, so a subprocess that re-reads the
 *  credential store gets a live token. */
export function isAuthRevokedFailure(message: string): boolean {
  return /\b401\b/.test(message) && /oauth/i.test(message) && /revoked|expired/i.test(message);
}

export function isDeadQueryFailure(message: string): boolean {
  return QUERY_CLOSED.test(message) || isAuthRevokedFailure(message);
}

export const RELOGIN_HINT =
  "usually a transient credential-refresh race; sending the message again typically works. If it persists, run `claude /login`.";

/** A 401 that outlives the retry is still most often the refresh race caught twice within
 *  its window, so the hint leads with try-again; genuine revocation is the rare case, and
 *  the bridge holds no credentials, so that case is only actionable in Claude Code's own
 *  terms. */
export function withReloginHint(message: string): string {
  if (!isAuthRevokedFailure(message) || message.includes(RELOGIN_HINT)) return message;
  return `${message} — ${RELOGIN_HINT}`;
}
