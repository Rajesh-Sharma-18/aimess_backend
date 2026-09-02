import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "@aimess/logger";
import { createGatewayAdminSocketAuthMiddleware } from "../auth.middleware.js";

/**
 * Payload schemas for the /admin subscribe events.
 *
 * Every other namespace validates with `safeParse`; these six handlers used
 * `payload?.x?.trim()` instead, which guards null and undefined but not a wrong
 * TYPE. Emitting `{groupId: 5}` made `(5).trim` undefined and threw a
 * TypeError synchronously inside the Socket.IO listener — Socket.IO does not
 * wrap listeners in try/catch, so it reached the process. The throw also
 * happened BEFORE the permission check, so any admin token could trigger it
 * regardless of granted permissions.
 *
 * The id shapes are not cosmetic. `admin:group:subscribe` joins
 * `conv:<groupId>`, and private DMs publish on that SAME Redis channel family —
 * so an id that is not a group id turns a `groups.moderate` grant into a live
 * feed of an arbitrary private conversation, message bodies and attachment URLs
 * included. Room ids are server-minted with a kind prefix
 * (`generateRoomId("grp"|"prv")` in chat-service) and the codebase already
 * treats that prefix as authoritative for authorization decisions, so requiring
 * `grp_` here is the same class of check, applied at the door.
 */
const GroupSubscribeSchema = z.object({
  groupId: z
    .string()
    .trim()
    .regex(
      /^grp_[A-Za-z0-9_-]{8,64}$/,
      "groupId must be a group room id (grp_…)"
    ),
});

/** Community and stream ids are Mongo ObjectIds — 24 lowercase hex chars. */
const objectId = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{24}$/i, "must be a 24-character object id");

const CommunitySubscribeSchema = z.object({ communityId: objectId });
const StreamSubscribeSchema = z.object({ streamId: objectId });

interface RedisSocketEvent {
  event: string;
  data: unknown;
}

/** Published by backoffice-service when an admin account is deactivated. */
const ADMIN_SESSION_REVOKED = "admin:session:revoked";

/**
 * Admin Community Conversation viewer: the client asks to watch/stop watching
 * ONE community's live message stream. Named with the `admin:` prefix so they
 * can never be confused with the user-facing `community:join` on /community,
 * which is a different namespace with different auth and different semantics.
 */
const ADMIN_COMMUNITY_SUBSCRIBE = "admin:community:subscribe";
const ADMIN_COMMUNITY_UNSUBSCRIBE = "admin:community:unsubscribe";

/**
 * Admin livestream monitor: the client asks to watch/stop watching ONE
 * livestream's realtime channel. Same shape and rationale as the community
 * viewer above — the admin token is signed with a different secret, so /stream
 * would reject it outright and the panel would otherwise need a parallel
 * livestream socket stack.
 */
const ADMIN_STREAM_SUBSCRIBE = "admin:stream:subscribe";
const ADMIN_STREAM_UNSUBSCRIBE = "admin:stream:unsubscribe";

/**
 * Admin Group Conversation viewer: watch/stop watching ONE group's live message
 * stream. Same shape and rationale as the community viewer — the admin token is
 * signed with a different secret, so the user-facing /chat namespace would
 * reject it outright and the panel would otherwise need a parallel chat socket.
 */
const ADMIN_GROUP_SUBSCRIBE = "admin:group:subscribe";
const ADMIN_GROUP_UNSUBSCRIBE = "admin:group:unsubscribe";

/**
 * The ONLY community events mirrored to /admin. The conversation viewer is
 * read-only, so typing/read-receipt/presence/member traffic is deliberately
 * excluded — an allowlist rather than a denylist, so a future event added to
 * the community channel is not silently exposed to the admin panel.
 */
const ADMIN_VIEWABLE_COMMUNITY_EVENTS = new Set([
  "community:message:new",
  "community:message:edited",
  "community:message:deleted",
  "community:member:removed",
]);

/**
 * The ONLY stream events mirrored to /admin. Same allowlist discipline as the
 * community set above. Deliberately excluded: `stream:banned`,
 * `stream:member_muted` and `stream:member_unmuted`, which stream-service
 * publishes to the room but the /stream gateway re-routes to the ONE affected
 * viewer — relaying them here would broadcast another user's moderation state
 * to the panel. `stream:playable` is a broadcaster-side readiness ping with no
 * meaning to a monitor.
 *
 * `stream:comment:new` needs no avatar enrichment here: stream-service resolves
 * `senderAvatar` to a presigned URL before publishing (its /stream counterpart
 * re-presigns only for legacy raw-key rows).
 */
/**
 * The ONLY group (chat) events mirrored to /admin. Group messages travel on the
 * shared `conv:<roomId>` channel (private DMs use the same channel), so the
 * allowlist is doubly important here — it keeps DM-shaped events off the panel
 * even though the viewer only ever joins a group's conv room. Read-only: message
 * lifecycle plus the two moderation-state events the viewer must reflect live
 * (a member banned/removed, the group closed by an owner ban).
 */
const ADMIN_VIEWABLE_GROUP_EVENTS = new Set([
  "message:new",
  "message:edited",
  "message:delete",
  "group:member:removed",
  "group:closed",
]);

const ADMIN_VIEWABLE_STREAM_EVENTS = new Set([
  "stream:comment:new",
  "stream:comment:deleted",
  "stream:status",
  "stream:info_updated",
  "stream:comment_status",
  "stream:quality",
]);

/**
 * Permission required to watch a community's live conversation. The stream
 * carries the same message bodies as the REST read
 * (GET /admin/v1/communities/:id/messages), so it MUST be gated on the same
 * permission — otherwise the socket is an unauthenticated back door around
 * `requirePermission(COMMUNITIES_MODERATE)`.
 */
const COMMUNITIES_MODERATE = "communities.moderate";

/**
 * Permission required to watch a group's live conversation. Same message bodies
 * as GET /admin/v1/groups/:id/messages, so it MUST match that route's guard.
 */
const GROUPS_MODERATE = "groups.moderate";

/**
 * Permission required to monitor a livestream. Matches the REST guard on
 * GET /admin/v1/livestreams/:id — the socket carries the same comment bodies
 * as GET /admin/v1/livestreams/:id/comments, so it must not be a cheaper door.
 */
const LIVESTREAMS_READ = "livestreams.read";

/** Mirrors backoffice-service's lib/admin-perms-cache.ts key format. */
const ADMIN_PERMS_PREFIX = "aimess:admin:perms:";

/**
 * Read the admin's effective permissions from the cache backoffice-service
 * populates on EVERY authenticated admin REST request (60s TTL, see its
 * api/middleware/admin-auth.ts). The gateway has no admin DB of its own, so a
 * cache MISS is not an authorization decision it can make — it denies, and the
 * client re-subscribes after its next REST read (which repopulates the key).
 * The admin panel subscribes only after a successful detail fetch, so the key
 * is warm by construction.
 *
 * Fails CLOSED on a Redis error, unlike the handshake middleware. The two are
 * not comparable: the handshake has already verified a signed admin token and
 * is only re-checking revocation, whereas this IS the authorization decision
 * for the subscription. Failing open here would hand out a livestream/community
 * feed the admin may not be entitled to, and the retry costs the client only a
 * re-subscribe.
 */
async function adminHasPermission(
  redisPub: Redis,
  adminId: string,
  permission: string
): Promise<boolean> {
  let cached: string | null;
  try {
    cached = await redisPub.get(`${ADMIN_PERMS_PREFIX}${adminId}`);
  } catch (err) {
    logger.warn(
      `/admin permission cache read failed for ${adminId}, denying: ${String(err)}`
    );
    return false;
  }
  if (!cached) return false;
  try {
    return (JSON.parse(cached) as string[]).includes(permission);
  } catch {
    return false;
  }
}

/**
 * Backoffice admin-panel namespace. Carries account-level pushes for the signed-in
 * admin — `admin:permissions:updated` (a grant/revoke by a Platform Admin lands on
 * the target's open panel instead of waiting for a re-login) and
 * `admin:session:revoked` (account deactivated).
 *
 * One durable PSUBSCRIBE on `admin:*` (a permission edit is rare — per-admin
 * ref-counted subscribes like /notify's would be bookkeeping for nothing), and
 * every socket joins the room named after its own channel, so a message only
 * reaches the admin it is about.
 */
export function registerAdminNamespace(
  io: SocketIOServer,
  redisSub: Redis,
  redisPub: Redis
): void {
  const admin: Namespace = io.of("/admin");
  admin.use(createGatewayAdminSocketAuthMiddleware(redisPub));

  redisSub.on(
    "pmessage",
    (_pattern: string, channel: string, message: string) => {
      // Community mirror for the conversation viewer. Same "channel name IS the
      // room name" convention as the admin: branch below, but the room is joined
      // on demand by a permission-checked subscribe rather than at connect. Room
      // registries are per-namespace, so `community:<id>` here never collides
      // with the identically-named room on /community.
      if (channel.startsWith("community:")) {
        // EVERY gateway node psubscribes `community:*`, so every node receives
        // this message independently. Delivery must therefore be LOCAL: a
        // cluster-wide `admin.to(...)` would have each node re-broadcast the
        // same event through the Redis adapter, delivering it once per node to
        // an admin watching. `.local` also means a message costs nothing on the
        // nodes where no admin is watching.
        if (!admin.adapter.rooms.has(channel)) return;
        try {
          const parsed = JSON.parse(message) as RedisSocketEvent;
          if (ADMIN_VIEWABLE_COMMUNITY_EVENTS.has(parsed.event)) {
            admin.local.to(channel).emit(parsed.event, parsed.data);
          }
        } catch (err) {
          logger.warn(
            `/admin Redis message parse error on ${channel}: ${String(err)}`
          );
        }
        return;
      }

      // Group mirror for the conversation viewer. Group messages travel on the
      // SHARED `conv:<roomId>` channel (private DMs too), so the room-membership
      // gate below is what scopes delivery: only a group whose `conv:<groupId>`
      // room an admin has joined ever emits, and the allowlist keeps DM-shaped
      // events off the panel regardless.
      if (channel.startsWith("conv:")) {
        if (!admin.adapter.rooms.has(channel)) return;
        try {
          const parsed = JSON.parse(message) as RedisSocketEvent;
          if (ADMIN_VIEWABLE_GROUP_EVENTS.has(parsed.event)) {
            admin.local.to(channel).emit(parsed.event, parsed.data);
          }
        } catch (err) {
          logger.warn(
            `/admin Redis message parse error on ${channel}: ${String(err)}`
          );
        }
        return;
      }

      // Livestream mirror for the monitor. Same channel-name-IS-room-name
      // convention; `stream:<streamId>` here is a /admin room, distinct from
      // the identically-named room on /stream.
      if (channel.startsWith("stream:")) {
        // Local delivery only, for the same reason as the community branch
        // above: every node psubscribes `stream:*`, so a cluster-wide
        // `admin.to(...)` would fan the same comment out once per node.
        if (!admin.adapter.rooms.has(channel)) return;
        try {
          const parsed = JSON.parse(message) as RedisSocketEvent;
          if (ADMIN_VIEWABLE_STREAM_EVENTS.has(parsed.event)) {
            admin.local.to(channel).emit(parsed.event, parsed.data);
          }
        } catch (err) {
          logger.warn(
            `/admin Redis message parse error on ${channel}: ${String(err)}`
          );
        }
        return;
      }

      // channel = "admin:<adminId>" = the room name
      if (!channel.startsWith("admin:")) return;
      try {
        const parsed = JSON.parse(message) as RedisSocketEvent;
        admin.to(channel).emit(parsed.event, parsed.data);

        // The account is gone — the client logs itself out on this event, but the
        // handshake that authorized this socket is now stale, so drop it here too.
        if (parsed.event === ADMIN_SESSION_REVOKED) {
          void admin
            .in(channel)
            .fetchSockets()
            .then((sockets) => {
              for (const socket of sockets) socket.disconnect(true);
            })
            .catch((err: unknown) =>
              logger.warn(`/admin revoke disconnect failed: ${String(err)}`)
            );
        }
      } catch (err) {
        logger.warn(
          `/admin Redis message parse error on ${channel}: ${String(err)}`
        );
      }
    }
  );

  void redisSub.psubscribe("admin:*");
  // One durable pattern for the conversation viewer, same rationale as admin:*
  // — a viewer is opened rarely, so per-community ref-counted subscribes would
  // be bookkeeping for nothing. Delivery is still scoped by room membership:
  // with no admin subscribed, `admin.to(...)` fans out to nobody.
  void redisSub.psubscribe("community:*");
  // Group conversation viewer. `conv:*` also carries private DM traffic, but the
  // per-message `admin.adapter.rooms.has(channel)` short-circuit above means a
  // conv nobody is watching costs nothing, and the allowlist scopes what leaks.
  void redisSub.psubscribe("conv:*");
  // Same again for the livestream monitor. stream-service is the only publisher
  // on `stream:<id>`; the presence hashes that share the prefix are plain keys,
  // never channels.
  void redisSub.psubscribe("stream:*");

  admin.on("connection", (socket: Socket) => {
    const { adminId } = socket.data;
    void socket.join(`admin:${adminId}`);
    // Shared broadcast room for panel-wide list bumps (currently: the livestream
    // datatable). No permission gate here because the payloads are empty by
    // contract — the client refetches on receipt, and REST enforces its own
    // permissions on the refetch, so an admin without livestreams.read receives
    // a bump they do nothing with. Publishers: any service that redis.publish
    // to channel "admin:broadcast" with the standard `{event, data}` envelope.
    void socket.join("admin:broadcast");
    logger.debug(`/admin connected adminId=${String(adminId)}`);

    // Token expiry, enforced mid-connection.
    //
    // `socket.data.tokenExpiresAt` was set at handshake and acted on by nobody,
    // so a de-provisioned admin's open browser tab kept streaming mirrored
    // community, group and livestream traffic for as long as the TCP connection
    // survived — days after the admin token expired. Only an explicit session
    // revocation closed it.
    //
    // Deliberately NOT the shared `createSessionTimers` helper the user
    // namespaces use: that offers an `auth:refresh` event which exchanges a
    // USER refresh token at auth-service. Admin sessions are a different
    // credential with a different secret and their own rotation endpoint, so
    // wiring it here would either do nothing or accept the wrong token type.
    // An expired admin socket is disconnected; the panel reconnects with a
    // freshly refreshed admin token, which is what it already does on a drop.
    const expiresAt = Number(socket.data.tokenExpiresAt ?? 0);
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    if (expiresAt > 0) {
      expiryTimer = setTimeout(
        () => {
          expiryTimer = null;
          logger.debug(
            `/admin token expired, disconnecting adminId=${String(adminId)}`
          );
          socket.emit("session:expired", {
            reason: "TOKEN_EXPIRED",
            expiresAt,
            reconnect: true,
          });
          socket.disconnect(true);
        },
        Math.max(0, expiresAt - Date.now())
      );
    }

    // Communities this socket currently WANTS to watch. The permission check is
    // async, so without this an unsubscribe issued during the check would run
    // first (leave is synchronous) and the join would land after it, leaving the
    // socket in a room it had already asked to leave — a silent viewer that
    // keeps receiving messages.
    const desiredCommunities = new Set<string>();

    socket.on(
      ADMIN_COMMUNITY_SUBSCRIBE,
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = CommunitySubscribeSchema.safeParse(payload);
        if (!parsed.success) {
          callback?.({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const communityId = parsed.data.communityId;
        desiredCommunities.add(communityId);
        void (async () => {
          if (
            !(await adminHasPermission(
              redisPub,
              String(adminId),
              COMMUNITIES_MODERATE
            ))
          ) {
            desiredCommunities.delete(communityId);
            logger.warn(
              `/admin community subscribe denied adminId=${String(adminId)} community=${communityId}`
            );
            // Told explicitly rather than left silent: a denial is otherwise
            // indistinguishable from a quiet community, and the client needs to
            // know its live view is not live.
            callback?.({ success: false, error: "FORBIDDEN" });
            return;
          }
          // Unsubscribed while the permission check was in flight.
          if (!desiredCommunities.has(communityId)) {
            callback?.({ success: false, error: "UNSUBSCRIBED" });
            return;
          }
          await socket.join(`community:${communityId}`);
          callback?.({ success: true });
        })();
      }
    );

    socket.on(
      ADMIN_COMMUNITY_UNSUBSCRIBE,
      (payload: unknown) => {
        const parsed = CommunitySubscribeSchema.safeParse(payload);
        if (!parsed.success) return;
        const communityId = parsed.data.communityId;
        desiredCommunities.delete(communityId);
        void socket.leave(`community:${communityId}`);
      }
    );

    // Groups this socket currently WANTS to watch — same race guard as the
    // community set above (async permission check vs. a sync unsubscribe).
    const desiredGroups = new Set<string>();

    socket.on(
      ADMIN_GROUP_SUBSCRIBE,
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = GroupSubscribeSchema.safeParse(payload);
        if (!parsed.success) {
          // Includes an id that is not a group room id — see the schema note:
          // a `prv_` id here would mirror a private conversation to the panel.
          callback?.({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const groupId = parsed.data.groupId;
        desiredGroups.add(groupId);
        void (async () => {
          if (
            !(await adminHasPermission(
              redisPub,
              String(adminId),
              GROUPS_MODERATE
            ))
          ) {
            desiredGroups.delete(groupId);
            logger.warn(
              `/admin group subscribe denied adminId=${String(adminId)} group=${groupId}`
            );
            callback?.({ success: false, error: "FORBIDDEN" });
            return;
          }
          if (!desiredGroups.has(groupId)) {
            callback?.({ success: false, error: "UNSUBSCRIBED" });
            return;
          }
          // Group messages travel on `conv:<roomId>`; the /admin room shares
          // that name (distinct from /chat's identically-named room).
          await socket.join(`conv:${groupId}`);
          callback?.({ success: true });
        })();
      }
    );

    socket.on(
      ADMIN_GROUP_UNSUBSCRIBE,
      (payload: unknown) => {
        const parsed = GroupSubscribeSchema.safeParse(payload);
        if (!parsed.success) return;
        const groupId = parsed.data.groupId;
        desiredGroups.delete(groupId);
        void socket.leave(`conv:${groupId}`);
      }
    );

    socket.on(
      ADMIN_STREAM_SUBSCRIBE,
      (payload: unknown, callback?: (res: unknown) => void) => {
        const parsed = StreamSubscribeSchema.safeParse(payload);
        if (!parsed.success) {
          callback?.({ success: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const streamId = parsed.data.streamId;
        void (async () => {
          if (
            !(await adminHasPermission(
              redisPub,
              String(adminId),
              LIVESTREAMS_READ
            ))
          ) {
            logger.warn(
              `/admin stream subscribe denied adminId=${String(adminId)} stream=${streamId}`
            );
            callback?.({ success: false, error: "FORBIDDEN" });
            return;
          }
          await socket.join(`stream:${streamId}`);
          callback?.({ success: true });
        })();
      }
    );

    // "Leave Livestream" — drops this admin's monitoring session only. The
    // broadcast itself is untouched: the panel never joined the /stream room
    // that stream-service counts, so there is nothing to tear down upstream.
    socket.on(
      ADMIN_STREAM_UNSUBSCRIBE,
      (payload: unknown) => {
        const parsed = StreamSubscribeSchema.safeParse(payload);
        if (parsed.success) void socket.leave(`stream:${parsed.data.streamId}`);
      }
    );

    socket.on("disconnect", (reason: string) => {
      if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      logger.debug(
        `/admin disconnected adminId=${String(adminId)} reason=${reason}`
      );
    });
  });
}
