import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";

/**
 * Hook contract the presence service uses to trigger delivered-tick backfill
 * for offline messages when a user comes back online. Injected AFTER the
 * message services are constructed (mutual dependency), via `wireBackfill`.
 */
export interface PresenceBackfillHooks {
  backfillDeliveredOnPresenceConnect(userId: string): Promise<void>;
}

/**
 * `whoCanSeeOnlineStatus` gate (user-service). Implementations MUST fail
 * CLOSED — an empty set on transport failure.
 *
 * `filterVisiblePresence` is the viewer-scoped read ("which of these peers may
 * I see?") and is the one this service uses. `filterPresenceViewers` is the
 * subject-scoped inverse ("who may hear that I went offline?"); it exists on
 * the gRPC surface and is kept here for parity, but presence fan-out no longer
 * needs it — `presence:status` is delivered to the `presence:<subjectId>` room,
 * whose membership was already gated at `presence:subscribe` time.
 */
export interface PresenceVisibilityGate {
  filterVisiblePresence(
    viewerId: string,
    peerIds: string[]
  ): Promise<Set<string>>;
  filterPresenceViewers(
    subjectId: string,
    viewerIds: string[]
  ): Promise<Set<string>>;
}

/**
 * What a client needs to render a peer's presence, and to decide whether an
 * arriving event is newer than what it already shows.
 */
export interface PresenceView {
  userId: string;
  isOnline: boolean;
  /** Server-generated epoch ms. Meaningful only while `isOnline` is false. */
  lastSeen: number | null;
  /** Monotonic per-user counter; advances ONLY on an ONLINE↔OFFLINE flip. */
  version: number;
}

export class PresenceService {
  private readonly backgroundTimeoutMs: number;
  /**
   * How long an ONLINE belief stays credible without a device-session refresh.
   * Must exceed the device-session TTL, or the sweeper would keep re-checking
   * users whose sessions are simply not due to expire yet.
   */
  private readonly staleAfterMs: number;
  private privateBackfill?: PresenceBackfillHooks;
  private groupBackfill?: PresenceBackfillHooks;

  constructor(
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster | null,
    options?: { backgroundTimeoutMs?: number; staleAfterMs?: number },
    // Optional, and it fails CLOSED, not open: with no gate wired, every
    // viewer-scoped read returns "offline". Presence is a privacy decision — a
    // missing dependency must not turn into an open disclosure.
    private readonly visibilityGate?: PresenceVisibilityGate
  ) {
    this.backgroundTimeoutMs = options?.backgroundTimeoutMs || 5 * 60 * 1000;
    this.staleAfterMs = options?.staleAfterMs || 3 * 60 * 1000;
  }

  /**
   * `isOnline` for ONE subject as `viewerId` is allowed to see it — the read
   * every user-facing surface must use (REST presence, room details). A denied
   * viewer gets `false`, indistinguishable from genuinely offline.
   */
  async getPresenceFor(viewerId: string, subjectId: string): Promise<boolean> {
    if (!this.visibilityGate) return false;
    const visible = await this.visibilityGate.filterVisiblePresence(viewerId, [
      subjectId,
    ]);
    return visible.has(subjectId) ? this.getPresence(subjectId) : false;
  }

  /**
   * Batch twin of {@link getPresenceFor}. Peers the viewer may not see are
   * reported `false` rather than omitted, so callers cannot distinguish
   * "hidden" from "offline" and no call site has to handle a missing key.
   */
  async getPresenceManyFor(
    viewerId: string,
    peerIds: string[]
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>(peerIds.map((id) => [id, false]));
    if (peerIds.length === 0 || !this.visibilityGate) return result;
    const visible = await this.visibilityGate.filterVisiblePresence(
      viewerId,
      peerIds
    );
    if (visible.size === 0) return result;
    const online = await this.getPresenceMany([...visible]);
    for (const [id, isOnline] of online) result.set(id, isOnline);
    return result;
  }

  /** `lastSeen` for one subject, gated by the same `whoCanSeeOnlineStatus` scope. */
  async getLastSeenFor(
    viewerId: string,
    subjectId: string
  ): Promise<number | null> {
    if (!this.visibilityGate) return null;
    const visible = await this.visibilityGate.filterVisiblePresence(viewerId, [
      subjectId,
    ]);
    return visible.has(subjectId) ? this.getLastSeen(subjectId) : null;
  }

  /**
   * Late-bound wiring for the presence-connect delivered-tick backfill hooks,
   * called AFTER construction because Presence and Private/Group message
   * services depend on each other. Absent injection is a valid state — the
   * backfill simply doesn't run (test/legacy compatible).
   */
  wireBackfill(hooks: {
    privateMessages?: PresenceBackfillHooks;
    groupMessages?: PresenceBackfillHooks;
  }): void {
    this.privateBackfill = hooks.privateMessages;
    this.groupBackfill = hooks.groupMessages;
  }

  /** Single canonical online-status read — reused by REST responses and conv:updated. */
  async getIsOnline(userId: string): Promise<boolean> {
    return this.getPresence(userId);
  }

  /** Batch canonical online-status read — one Redis round trip for many peers. */
  async getPresenceMany(userIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (userIds.length === 0) return result;
    try {
      const statuses = await this.cacheRepo.getUserPresences(userIds);
      if (statuses instanceof Map) {
        for (const [id, status] of statuses)
          result.set(id, status === "online");
      }
    } catch (error) {
      logger.warn(`PresenceService|getPresenceMany|error=${error}`);
    }
    return result;
  }

  /**
   * Re-derive aggregate online status from this user's device sessions and, if
   * it actually flipped, broadcast it.
   *
   * "Online" means AT LEAST ONE live session — never "the last socket that
   * happened to report in". That is what makes multi-device work: a browser
   * closing while the phone stays connected recomputes to online again and
   * publishes nothing, because nothing changed.
   *
   * The status write, the version bump and the `lastSeen` stamp happen inside
   * one Redis script, so `changed` is decided exactly once no matter how many
   * chat-service replicas call this concurrently — which is also what stops two
   * replicas from publishing contradictory events with out-of-order versions.
   */
  async recompute(userId: string): Promise<void> {
    try {
      const sessions = await this.cacheRepo.getDeviceSessions(userId);
      const now = Date.now();

      const isOnline = sessions.some((session) => {
        if (session.realtimeConnected !== "1") return false;
        if (session.appState === "FOREGROUND") return true;
        if (session.appState === "BACKGROUND") {
          const lastActive = Number(session.lastActiveAt || 0);
          return now - lastActive < this.backgroundTimeoutMs;
        }
        return false;
      });

      const transition = await this.cacheRepo.applyPresenceTransition(
        userId,
        isOnline,
        now
      );

      // Keep the sweeper index in step on EVERY recompute, not just on a flip:
      // a still-online user needs a fresh staleness deadline or the sweeper
      // would re-check them forever.
      await this.cacheRepo
        .setOnlineIndex(userId, isOnline, now + this.staleAfterMs)
        .catch((err: unknown) =>
          logger.warn(
            `PresenceService|onlineIndex|userId=${userId}|error=${String(err)}`
          )
        );

      // Offline→online transition: sweep any messages that landed while the
      // user was offline and mark them delivered — fires one `message:delivered`
      // per affected room so senders' ticks catch up without waiting for the
      // client to individually ack each incoming message on catchup.
      if (transition.changed && isOnline) {
        if (this.privateBackfill) {
          void this.privateBackfill
            .backfillDeliveredOnPresenceConnect(userId)
            .catch((err) =>
              logger.warn(
                `PresenceService|privateBackfill|userId=${userId}|error=${String(err)}`
              )
            );
        }
        if (this.groupBackfill) {
          void this.groupBackfill
            .backfillDeliveredOnPresenceConnect(userId)
            .catch((err) =>
              logger.warn(
                `PresenceService|groupBackfill|userId=${userId}|error=${String(err)}`
              )
            );
        }
      }

      if (transition.changed && this.redis) {
        // Published on `user:<subjectId>`; the gateway mirrors ONLY this event
        // to the `presence:<subjectId>` watcher room, which is join-gated by
        // whoCanSeeOnlineStatus. Nothing here is a broadcast.
        await this.redis.publish(
          `user:${userId}`,
          JSON.stringify({
            event: "presence:status",
            data: {
              userId,
              isOnline,
              lastActiveAt: isOnline
                ? now
                : Number(sessions[0]?.lastActiveAt ?? now),
              lastSeen: transition.lastSeen,
              version: transition.version,
            },
          })
        );
      }
    } catch (error) {
      logger.error(`PresenceService|recompute|userId=${userId}|error=${error}`);
    }
  }

  /**
   * Re-derive presence for every user whose ONLINE belief has outlived its
   * staleness deadline, and let {@link recompute} emit the resulting OFFLINE.
   *
   * Without this, an unclean disappearance is invisible: the device-session
   * hashes quietly expire, but no code path reads them again, so no
   * `presence:status` is ever published and every watcher keeps a green dot
   * until they happen to refetch. That is the "still shows Online until a hard
   * refresh" symptom.
   *
   * Idempotent and multi-node safe — the transition script decides `changed`
   * atomically, so N replicas sweeping the same user still produce one event.
   * Returns how many users were re-derived.
   */
  async sweepStaleSessions(limit: number): Promise<number> {
    const staleUserIds = await this.cacheRepo.getStaleOnlineUserIds(
      Date.now(),
      limit
    );
    for (const userId of staleUserIds) {
      await this.recompute(userId);
    }
    return staleUserIds.length;
  }

  /**
   * Viewer-scoped presence for many peers in one pass — what a conversation
   * list, a room-details response, or a `presence:subscribe` ack needs to show
   * the right state immediately, without waiting for the next flip.
   * Peers the viewer may not see are reported offline with no last-seen.
   */
  async getPresenceViewsFor(
    viewerId: string,
    peerIds: string[]
  ): Promise<Map<string, PresenceView>> {
    const views = new Map<string, PresenceView>(
      peerIds.map((id) => [
        id,
        { userId: id, isOnline: false, lastSeen: null, version: 0 },
      ])
    );
    if (peerIds.length === 0 || !this.visibilityGate) return views;

    const visible = await this.visibilityGate.filterVisiblePresence(
      viewerId,
      peerIds
    );
    if (visible.size === 0) return views;

    const snapshots = await this.cacheRepo.getPresenceSnapshots([...visible]);
    for (const [id, snapshot] of snapshots) views.set(id, snapshot);
    return views;
  }

  async connect(
    userId: string,
    deviceId: string,
    meta: { platform: string; clientType: string; appState: string }
  ): Promise<void> {
    await this.cacheRepo.upsertDeviceSession({
      userId,
      deviceId,
      socketId: "",
      platform: meta.platform,
      clientType: meta.clientType,
      realtimeConnected: true,
      appState: meta.appState,
      now: Date.now(),
    });
    await this.recompute(userId);
  }

  /**
   * One socket went away. This is NOT "the user is offline" — `recompute`
   * decides that from the sessions that remain, so another tab or the phone
   * still holding a connection keeps them online. `lastSeen` is stamped by the
   * transition script at the moment the LAST session goes, never here: writing
   * it on every socket close would move the timestamp while the user is still
   * online, and the value would be wrong for exactly as long as they stayed.
   */
  async disconnect(userId: string, deviceId: string): Promise<void> {
    await this.cacheRepo.setDisconnected({
      userId,
      deviceId,
      nowMs: Date.now(),
    });
    await this.recompute(userId);
  }

  async heartbeat(
    userId: string,
    deviceId: string,
    appState?: string
  ): Promise<void> {
    if (appState) {
      await this.cacheRepo.setAppState(userId, deviceId, appState, Date.now());
    } else {
      await this.cacheRepo.heartbeat({ userId, deviceId, now: Date.now() });
    }
    await this.recompute(userId);
  }

  async getPresence(userId: string): Promise<boolean> {
    const status = await this.cacheRepo.getUserPresence(userId);
    return status === "online";
  }

  async getLastSeen(userId: string): Promise<number | null> {
    return this.cacheRepo.getLastSeen(userId);
  }

  /*
   * REMOVED — presence used to ALSO fan out as a `conv:updated` carrying
   * `isOffline`, to every private room the user was in (capped at 500 publishes
   * per flip). It was a second, lossy presence channel:
   *
   *  - `conv:updated` is a conversation-list BUMP. Rebuilding one from a room's
   *    stored columns meant a room with no messages yet republished
   *    `lastMessageAt: 0` and an empty preview, so a peer merely going online
   *    reset that row's sort key and blanked its last-message text.
   *  - It could disagree with `presence:status`, which is the actual contract,
   *    leaving the conversation list and the chat header showing different
   *    states for the same peer — the exact divergence this work had to fix.
   *
   * Presence now travels on `presence:status` alone. The conversation list gets
   * its initial state from the REST inbox (`peer.isOnline` / `peer.lastSeen`)
   * and every change from that one event.
   */
}
