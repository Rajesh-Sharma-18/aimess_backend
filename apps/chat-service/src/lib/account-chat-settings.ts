/**
 * One user's account-wide Settings → Chat block (user-service `ChatSettings`),
 * behind a short in-process TTL cache.
 *
 * Every field here is consulted on a hot path — the auto-delete default on every
 * private send, the read-receipt switch on every mark-read — so an uncached
 * lookup would turn one gRPC round trip into one per message. The TTL is the
 * whole invalidation story: a user who changes a switch sees it apply within a
 * minute, the same eventual-consistency budget the presence and friendship
 * lookups already run on.
 *
 * Fails open (see `userGrpcClient.getChatSettings`): no timer, indicators ON.
 */
import {
  userGrpcClient,
  type ChatSettings,
} from "../grpc/user-snapshot.client.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Deliberately re-declared here rather than imported from the gRPC client: that
 * whole module is jest.mock'd in the test harness, so a fallback imported from
 * it is `undefined` under test — exactly when the fallback path runs.
 */
const FALLBACK: ChatSettings = {
  autoDeleteTimer: "OFF",
  autoDeleteDefaultMode: "",
  autoDeleteDefaultTtlSeconds: null,
  typingIndicators: true,
  readReceipts: true,
  readReceiptsEnabledAt: 0,
};

const cache = new Map<string, { value: ChatSettings; expiresAt: number }>();
// In-flight lookups, so N concurrent callers for one user (a burst of reads,
// or the settings gate racing the mark-read write) share ONE round trip.
const inFlight = new Map<string, Promise<ChatSettings>>();
// A failed/timed-out lookup is remembered only briefly. It used to be
// remembered not at all, which meant a slow user-service charged EVERY
// mark-read the full gRPC timeout (2s) before its receipt could publish, with
// nothing ever warming up. Kept far shorter than TTL_MS on purpose: a user's
// disabled read receipts broadcast for a few seconds past recovery, not a
// minute.
const FAIL_OPEN_MS = 5_000;

function remember(userId: string, value: ChatSettings, ttlMs: number): void {
  // Map preserves insertion order — drop the oldest rather than growing unbounded.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { value, expiresAt: Date.now() + ttlMs });
}

export function getAccountChatSettings(userId: string): Promise<ChatSettings> {
  if (!userId) return Promise.resolve(FALLBACK);

  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);

  const pending = inFlight.get(userId);
  if (pending) return pending;

  // The client already fails open; this catch is the belt to that braces. A
  // settings lookup is never worth failing a send or a mark-read over, and the
  // two layers are edited by different people at different times.
  const p = userGrpcClient
    .getChatSettings(userId)
    .catch(() => null)
    .then((value) => {
      if (!value) {
        remember(userId, FALLBACK, FAIL_OPEN_MS);
        return FALLBACK;
      }
      remember(userId, value, TTL_MS);
      return value;
    })
    .finally(() => {
      inFlight.delete(userId);
    });
  inFlight.set(userId, p);
  return p;
}

/**
 * May this user's read receipts be shown to the people they read?
 *
 * The SENDER half of the reciprocal rule — it answers "may I publish this
 * reader's receipt at all". The other half (a VIEWER who switched receipts off
 * must not be shown anyone else's) cannot be decided here: one `message:read` /
 * `community:message:read` broadcast reaches many viewers with different
 * settings, so it is enforced per recipient at delivery, in the gateway's
 * `sockets/chat-flags.ts`. REST list ticks apply both halves themselves — see
 * `PrivateRoomService.enrichConversations` and
 * `GroupRoomService.computeLastMessageReadStatuses`.
 */
export async function mayBroadcastReadReceipts(
  userId: string
): Promise<boolean> {
  const { readReceipts } = await getAccountChatSettings(userId);
  return readReceipts;
}

/** Drop a user's cached value — used by tests. */
export function invalidateAccountChatSettings(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
