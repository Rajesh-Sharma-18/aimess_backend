/**
 * Run `load` at most once, however many consumers ask for it, and hand every
 * caller the same promise.
 *
 * Why this exists: the fan-out after a send has several independent consumers
 * that each need the room's recipient list — the `message:new` personal
 * fan-out, the `*:updated` inbox bump and the FCM push — and each was handed
 * its own lazy `fetchRecipients` thunk. One group send therefore issued the
 * SAME roster query three times (community: twice), all of them O(members).
 * Measured on a 26-member community, the duplicate reads cost ~27 ms per
 * message, and because the fan-out runs on the same event loop that time lands
 * on the NEXT send's latency.
 *
 * Laziness is preserved on purpose: nothing is queried unless at least one
 * consumer actually runs (the push publisher, for instance, returns early when
 * RabbitMQ is not configured).
 *
 * Scope is ONE send. A rejection is memoized along with everything else, so do
 * not reuse an instance across requests — each send builds its own.
 */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => (inFlight ??= load());
}
