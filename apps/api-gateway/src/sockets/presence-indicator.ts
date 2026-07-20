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

export function createPresenceIndicator(opts: {
  /** Wire event names, e.g. "typing:start" / "typing:stop". */
  startEvent: string;
  stopEvent: string;
  broadcast: PresenceBroadcast;
  ttlMs?: number;
}): PresenceIndicator {
  const { startEvent, stopEvent, broadcast } = opts;
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
 * ponytail: one roster lookup per presence event, uncached — matches the
 * shipped /community behaviour exactly. If per-keystroke roster traffic ever
 * shows up in profiling, add a short TTL cache HERE and both namespaces
 * inherit it.
 */
export function createDirectRosterBroadcast(params: {
  namespace: Namespace;
  senderId: string;
  resolveRoster: (roomId: string) => Promise<string[]>;
  buildPayload: (roomId: string) => unknown;
  /** Optional cheap pre-gate (e.g. the CLOSED-community Set). */
  isSuppressed?: (roomId: string) => boolean;
}): PresenceBroadcast {
  const { namespace, senderId, resolveRoster, buildPayload, isSuppressed } =
    params;

  return async (roomId: string, event: string): Promise<void> => {
    if (isSuppressed?.(roomId)) return;

    const memberIds = await resolveRoster(roomId);
    if (!memberIds.includes(senderId)) return; // sender not an active member

    const recipientIds = memberIds.filter((id) => id !== senderId);
    if (recipientIds.length === 0) return;

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
