import type { Namespace, Socket } from "socket.io";
import { logger } from "@aimess/logger";

/**
 * Shared presence-indicator engine for typing and voice-recording indicators,
 * used by BOTH /chat (private + group) and /community.
 *
 * Extracted from the /community typing implementation, which is the reference
 * contract. Before this, each namespace owned its own copy of the timer map,
 * the clear helper, the TTL auto-stop, and the disconnect flush — four
 * near-identical copies (typing + recording, × 2 namespaces) that had already
 * drifted (e.g. /chat's TTL expiry emitted through `socket.to()` while its
 * disconnect flush emitted through `namespace.to()`).
 *
 * What lives HERE (identical for every chat kind):
 *   - per-socket, per-room countdown timers
 *   - the 6 s TTL auto-stop when `stop` never arrives (crash / network drop)
 *   - re-arming the window on every repeated `start`
 *   - flushing every pending timer on disconnect so peers never see a stuck
 *     "typing…" indicator
 *
 * What is INJECTED (the only thing that legitimately differs):
 *   - `broadcast` — how recipients are resolved and reached. Typing uses
 *     room-independent direct delivery (see {@link createDirectRosterBroadcast});
 *     recording stays room-based (see {@link createRoomBroadcast}).
 *
 * Authorization deliberately lives inside `broadcast`, not beside it: the
 * community model resolves the roster ONCE and uses it both as the
 * sender-membership oracle and as the recipient list. Splitting the two would
 * double the per-keystroke round trip for zero benefit.
 */

/** Server-side auto-stop window. Matches the value both namespaces already used. */
export const PRESENCE_TTL_MS = 6000;

/**
 * Delivers one presence event. `fromTimer` is true when the TTL fired rather
 * than the client sending an explicit stop — strategies that emit through the
 * sender's own socket must switch to a namespace-scoped emit in that case,
 * because a timer can outlive the socket's request context.
 */
export type PresenceBroadcast = (
  roomId: string,
  event: string,
  fromTimer: boolean
) => void | Promise<void>;

export interface PresenceIndicator {
  /** Handle an inbound start: re-arm the window and broadcast. */
  start(roomId: string): void;
  /** Handle an inbound stop: cancel the window and broadcast. */
  stop(roomId: string): void;
  /** Disconnect cleanup: cancel every pending window and broadcast a stop for each. */
  flush(): void;
}

/**
 * How long one socket reuses a resolved roster. Deliberately shorter than the
 * 6 s indicator TTL, so a membership change is picked up within one indicator
 * cycle; the TTL-fired stop bypasses the cache entirely.
 */
const ROSTER_CACHE_TTL_MS = 3000;

export function createPresenceIndicator(opts: {
  /** Wire event names, e.g. "typing:start" / "typing:stop". */
  startEvent: string;
  stopEvent: string;
  broadcast: PresenceBroadcast;
  ttlMs?: number;
  /**
   * Per-user opt-out (Settings → Chat → Typing Indicator). Gates STARTS only —
   * a stop is always delivered, so flipping the switch mid-burst can never
   * strand a peer on a "…is typing" that no longer has a stop coming. A
   * suppressed start makes the matching stop a harmless no-op on the client.
   *
   * Not consulted for the sender's own timers: the TTL still runs, it just has
   * nothing to broadcast.
   */
  canStart?: () => Promise<boolean>;
}): PresenceIndicator {
  const { startEvent, stopEvent, broadcast, canStart } = opts;
  const ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clear = (roomId: string): void => {
    const t = timers.get(roomId);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(roomId);
    }
  };

  const emit = (roomId: string, event: string, fromTimer: boolean): void => {
    void (async () => {
      try {
        if (event === startEvent && canStart && !(await canStart())) return;
        await broadcast(roomId, event, fromTimer);
      } catch (err) {
        // A presence event is best-effort — never let a roster lookup or a
        // dead socket reject into an unhandled rejection.
        logger.warn(
          `presence-indicator ${event} broadcast failed room=${roomId}: ${String(err)}`
        );
      }
    })();
  };

  return {
    start(roomId: string): void {
      clear(roomId);
      emit(roomId, startEvent, false);
      timers.set(
        roomId,
        setTimeout(() => {
          timers.delete(roomId);
          emit(roomId, stopEvent, true);
        }, ttlMs)
      );
    },

    stop(roomId: string): void {
      clear(roomId);
      emit(roomId, stopEvent, false);
    },

    flush(): void {
      for (const [roomId, timer] of timers) {
        clearTimeout(timer);
        emit(roomId, stopEvent, true);
      }
      timers.clear();
    },
  };
}

/**
 * Room-independent delivery — the /community typing model, now shared with
 * /chat.
 *
 * `resolveRoster` returns the authoritative participant list for the room and
 * does double duty:
 *   1. sender membership — a user absent from the roster is not authorized and
 *      the event is dropped (fail-closed; an empty roster suppresses too);
 *   2. the recipient set — every other member, reached through their
 *      `user:<id>` room, which every socket already joins at connect for
 *      unrelated reasons (DM relay, notifications).
 *
 * The consequence is that a recipient receives the indicator whether or not
 * they ever joined the conversation room — which is what makes sidebar typing
 * indicators work without an open chat view. The sender is excluded by never
 * being placed in the recipient set.
 *
 * The roster is re-resolved when the TTL fires: the timer runs outside the
 * request context and membership may have changed since.
 *
 * The roster resolution is cached per socket for {@link ROSTER_CACHE_TTL_MS}, which is the
 * fix this file's own note anticipated. Without it every `typing:start` frame
 * cost a chat-service gRPC call plus a database room read plus a cross-node
 * socket enumeration, and nothing rate-limits typing — so a client emitting
 * start/stop in a loop turned a cheap local loop into sustained load on the
 * gateway AND on chat-service. The TTL is well under the indicator's own 6 s
 * lifetime, so a membership change is still reflected within one indicator
 * cycle; the roster is re-resolved when the TTL fires, as before.
 */
export function createDirectRosterBroadcast(params: {
  namespace: Namespace;
  senderId: string;
  resolveRoster: (roomId: string) => Promise<string[]>;
  buildPayload: (roomId: string) => unknown;
  /** Optional cheap pre-gate (e.g. the CLOSED-community Set). */
  isSuppressed?: (roomId: string) => boolean;
  /**
   * Optional per-recipient gate, applied AFTER the sender-membership check.
   * Reciprocity (Settings → Chat → Typing Indicator): a user who turned their
   * own indicator off is not shown anyone else's either, so they are dropped
   * from the recipient set rather than from the roster — removing them from the
   * roster would instead read as "sender not a member" and kill the event for
   * everyone.
   */
  filterRecipients?: (userIds: string[]) => Promise<string[]>;
}): PresenceBroadcast {
  const {
    namespace,
    senderId,
    resolveRoster,
    buildPayload,
    isSuppressed,
    filterRecipients,
  } = params;

  /**
   * Roster cache, scoped to THIS broadcast — i.e. to one socket's indicator.
   *
   * Deliberately not process-wide: a shared cache would let one user's
   * membership read back another user's authorization decision, and the load
   * being removed is one client typing, which is per-socket by nature.
   *
   * In-flight promises are cached too, so a burst of frames for one room does
   * not all miss at once and issue a lookup each.
   */
  const rosterCache = new Map<
    string,
    { expiresAt: number; roster: Promise<string[]> }
  >();

  const resolveRosterCached = (roomId: string): Promise<string[]> => {
    const now = Date.now();
    const cached = rosterCache.get(roomId);
    if (cached && cached.expiresAt > now) return cached.roster;

    const roster = resolveRoster(roomId).catch((err: unknown) => {
      // Never cache a failure: the next frame must be free to retry, and a
      // cached empty roster would read as "sender is not a member" and suppress
      // the indicator for the whole TTL.
      rosterCache.delete(roomId);
      throw err;
    });
    rosterCache.set(roomId, { expiresAt: now + ROSTER_CACHE_TTL_MS, roster });

    // Bound the map: room ids are attacker-nameable, so an unbounded cache
    // would relocate the memory-growth problem the per-socket caps close.
    if (rosterCache.size > 500) {
      for (const [key, value] of rosterCache) {
        if (value.expiresAt <= now) rosterCache.delete(key);
      }
    }

    return roster;
  };

  return async (
    roomId: string,
    event: string,
    fromTimer = false
  ): Promise<void> => {
    if (isSuppressed?.(roomId)) return;

    // The TTL-fired stop always re-resolves. That timer runs outside the
    // request context, potentially seconds after the last frame, and membership
    // may have changed since — which is exactly the case the cache must not
    // answer from memory.
    const memberIds = fromTimer
      ? await resolveRoster(roomId)
      : await resolveRosterCached(roomId);
    if (!memberIds.includes(senderId)) return; // sender not an active member

    let recipientIds = memberIds.filter((id) => id !== senderId);
    if (recipientIds.length === 0) return;

    if (filterRecipients) {
      recipientIds = await filterRecipients(recipientIds);
      if (recipientIds.length === 0) return;
    }

    const sockets = await namespace
      .in(recipientIds.map((id) => `user:${id}`))
      .fetchSockets();
    const payload = buildPayload(roomId);
    for (const s of sockets) s.emit(event, payload);
  };
}

/**
 * Room-based delivery — the recording-indicator model, unchanged in behaviour
 * for both namespaces.
 *
 * Broadcasts through the sender's socket (which excludes the sender) while the
 * socket is live, and through the namespace once the TTL has fired. `rooms`
 * may name several Socket.IO rooms; Socket.IO de-duplicates recipients that
 * belong to more than one.
 */
export function createRoomBroadcast(params: {
  namespace: Namespace;
  socket: Socket;
  rooms: (roomId: string) => string[];
  buildPayload: (roomId: string) => unknown;
  /** Return false to drop the event (e.g. sender never joined / community closed). */
  isAuthorized?: (roomId: string) => boolean | Promise<boolean>;
}): PresenceBroadcast {
  const { namespace, socket, rooms, buildPayload, isAuthorized } = params;

  return async (
    roomId: string,
    event: string,
    fromTimer: boolean
  ): Promise<void> => {
    if (isAuthorized && !(await isAuthorized(roomId))) return;

    const targets = rooms(roomId);
    if (targets.length === 0) return;

    // socket.to() excludes the sender; after the TTL fires the socket may be
    // gone, so emit namespace-scoped instead (the sender is disconnected or
    // idle by definition at that point, so no self-echo results).
    const emitter = fromTimer ? namespace : socket;
    let chain = emitter.to(targets[0]!);
    for (const room of targets.slice(1)) chain = chain.to(room);
    chain.emit(event, buildPayload(roomId));
  };
}
