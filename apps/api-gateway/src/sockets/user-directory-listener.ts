import type { Server as SocketIOServer } from "socket.io";
import type { Redis } from "ioredis";
import { logger } from "@aimess/logger";

/**
 * Channel backoffice-service publishes on whenever a Super Admin moderation
 * action changes who is DISCOVERABLE: ban, suspend, unban, re-activate, and the
 * bulk equivalents (`announceUserDirectoryChange` in
 * `user-management.service.ts`).
 *
 * Deliberately not `user:<something>` — `chat.ns.ts` psubscribes `user:*` and
 * treats the segment after the colon as a userId, so a channel in that family
 * would be parsed as a per-user room.
 */
const USER_DIRECTORY_CHANNEL = "broadcast:user-directory";

/** Client-facing event name. Payload-free by contract — see below. */
const USER_DIRECTORY_CHANGED = "user:directory_changed";

/**
 * Tell every signed-in client that people-discovery results may have moved, so
 * an open search re-reads instead of showing a stale answer.
 *
 * Why a namespace-wide emit rather than a targeted one: search is not scoped to
 * a relationship. The people who can see a banned account in their results are
 * whoever happens to have typed a matching term — there is no room, no roster
 * and no presence subscription that describes that set, so there is nothing
 * narrower to address. `user-ban:<id>` (see `registerUserBanListener`) reaches
 * the banned account's OWN devices and is a different job.
 *
 * What it costs: one frame per moderation action to each connected socket.
 * Moderation actions are rare and operator-driven, and the client's reaction is
 * a React Query invalidation — which only REFETCHES the discovery queries that
 * are actually mounted. A reader with no search open pays nothing but the
 * frame.
 *
 * The payload is EMPTY, and that is a privacy decision, not laziness: naming
 * the moderated user would tell every connected account who was just banned.
 * "Re-read discovery" tells them nothing they cannot already observe by
 * searching, and the refetch is still filtered by the SUBJECT's own
 * `whoCanFindMe` and account status, so this can never widen what a viewer is
 * allowed to see.
 *
 * `/notify` is the namespace every signed-in client holds for the whole
 * session, and the one the website already binds its search-cache invalidation
 * to (`useFriendSearch`). Shares the durable session-revoke PSUBSCRIBE
 * connection — every handler on it receives each pmessage and filters by
 * channel — exactly like `registerSessionCreatedListener`.
 */
export function registerUserDirectoryListener(
  io: SocketIOServer,
  sessionSub: Redis
): void {
  sessionSub.on("pmessage", (_pattern: string, channel: string) => {
    if (channel !== USER_DIRECTORY_CHANNEL) return;
    try {
      io.of("/notify").emit(USER_DIRECTORY_CHANGED, {});
    } catch (err) {
      logger.warn(`user-directory broadcast failed: ${String(err)}`);
    }
  });

  // A pattern, not a plain SUBSCRIBE: this connection is in pattern mode for the
  // session channels above and ioredis delivers `pmessage` only for psubscribed
  // patterns. The pattern matches the one literal channel.
  void sessionSub.psubscribe(USER_DIRECTORY_CHANNEL);
}
