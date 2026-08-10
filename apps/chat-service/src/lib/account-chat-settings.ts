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
import {
  accountAutoDeleteSetting,
  AUTO_DELETE_OFF,
  type AutoDeleteSetting,
} from "./auto-delete.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Deliberately re-declared here rather than imported from the gRPC client: that
 * whole module is jest.mock'd in the test harness, so a fallback imported from
 * it is `undefined` under test — exactly when the fallback path runs.
 */
const FALLBACK: ChatSettings = {
  autoDeleteTimer: "OFF",
  typingIndicators: true,
  readReceipts: true,
};

const cache = new Map<string, { value: ChatSettings; expiresAt: number }>();

export async function getAccountChatSettings(
  userId: string
): Promise<ChatSettings> {
  if (!userId) return FALLBACK;

  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // The client already fails open; this catch is the belt to that braces. A
  // settings lookup is never worth failing a send or a mark-read over, and the
  // two layers are edited by different people at different times.
  const value = await userGrpcClient.getChatSettings(userId).catch(() => null);
  // Never CACHE the fallback: that would keep a user's disabled read receipts
  // broadcasting for a minute after user-service came back.
  if (!value) return FALLBACK;

  // Map preserves insertion order — drop the oldest rather than growing unbounded.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** The sender's account-wide default timer, as a room-shaped setting. */
export async function getAccountAutoDelete(
  userId: string
): Promise<AutoDeleteSetting> {
  if (!userId) return AUTO_DELETE_OFF;
  const { autoDeleteTimer } = await getAccountChatSettings(userId);
  return accountAutoDeleteSetting(autoDeleteTimer);
}

/**
 * May this user's read receipts be shown to the people they read?
 *
 * One-way by design: turning the switch off hides MY receipts from others, it
 * does not hide theirs from me. WhatsApp's reciprocal rule would mean filtering
 * the `conv:<roomId>` broadcast per recipient, which that channel cannot do.
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
