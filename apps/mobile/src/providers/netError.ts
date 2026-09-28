/** The server was not reached (no network, airplane mode, timeout, NAVIA's
 * "no internet" test mode) — as opposed to a server that answered with an error. */
export function isNetworkError(message: string | null | undefined): boolean {
  return !!message && /network request failed|aborted|abort|timed? ?out|offline|internet|could not connect|connection/i.test(message);
}
