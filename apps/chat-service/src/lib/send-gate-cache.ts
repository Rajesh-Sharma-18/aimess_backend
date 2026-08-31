/**
 * Short-lived memo of the two per-message facts a DM send re-derives from the
 * database on EVERY message: "may these two still talk to each other" and "who
 * are this room's participants".
 *
 * Why this exists: profiling a 10-message burst showed the send path issuing
 * ~7 sequential database round trips per message, and under concurrency every
 * one of them queues behind the others — the peer gate alone (friendship +
 * either-way block + ban MGET) went from 7 ms idle to 1.4 s inside a 50-message
 * burst. Neither fact changes between two messages typed a second apart, so
 * re-deriving them per message buys nothing and costs the whole burst.
 *
 * Correctness bound: an unfriend / block / ban that lands mid-burst stays
 * effective for at most {@link GATE_TTL_MS}. Unfriend and block arrive as
 * friendship events, and that consumer calls {@link invalidateSendGate}, so
 * those take effect on the very next message. A PLATFORM BAN has no event
 * consumer in this service at all — it is read straight off a Redis key — so
 * for a ban the TTL is the whole bound: a banned account can land at most
 * {@link GATE_TTL_MS} of further DMs into a conversation it was already
 * mid-burst in. Session revocation still cuts the socket independently.
 *
 * Participants are cached separately and need no invalidation: a private
 * room's roster is fixed at creation and can never change.
 */

/** Deliberately small. Long enough to cover a typing burst, short enough that a
 *  lost invalidation event is a blip rather than a hole. */
export const GATE_TTL_MS = 5_000;

/** Bounded so a long-lived process can never grow the map without limit. */
const MAX_ENTRIES = 20_000;

interface Entry<T> {
  until: number;
  value: T;
}

const gate = new Map<string, Entry<true>>();
const participants = new Map<string, Entry<string[]>>();

const pairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

function put<T>(map: Map<string, Entry<T>>, key: string, value: T): void {
  // Map preserves insertion order — evict oldest rather than growing forever.
  if (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { until: Date.now() + GATE_TTL_MS, value });
}

function get<T>(map: Map<string, Entry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.until <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

/**
 * Run `check` at most once per pair per {@link GATE_TTL_MS}. Only a PASS is
 * remembered: a rejection must be re-derived, so the moment a block is lifted
 * or a friend request is accepted the very next message goes through.
 */
export async function withPeerGateCache(
  userId: string,
  peerId: string,
  check: () => Promise<void>
): Promise<void> {
  const key = pairKey(userId, peerId);
  if (get(gate, key)) return;
  await check();
  put(gate, key, true);
}

/** Drop every cached verdict involving this user. */
export function invalidateSendGate(userId: string): void {
  if (!userId) return;
  for (const key of gate.keys()) {
    const [a, b] = key.split("|");
    if (a === userId || b === userId) gate.delete(key);
  }
}

/**
 * A private room's participant list, which is immutable once the room exists —
 * so unlike the gate above this needs no invalidation, only a TTL to bound
 * memory and to heal a room that was read before it was fully written.
 *
 * `load` must throw for a room that does not exist or that the caller is not in;
 * only a resolved, non-empty roster is ever cached, so a refusal is always
 * re-derived.
 */
export async function cachedRoomParticipants(
  roomId: string,
  load: () => Promise<string[]>
): Promise<string[]> {
  const cached = get(participants, roomId);
  if (cached) return cached;
  const ids = (await load()).filter(Boolean);
  if (ids.length > 0) put(participants, roomId, ids);
  return ids;
}

/** Test seam / room deletion. */
export function clearSendGateCaches(): void {
  gate.clear();
  participants.clear();
}
