import type { PrismaClient, Notification } from "../generated/prisma/index.js";
import {
  categoryWhere,
  LOGIN_DETECTED_TYPE,
  NOTIFICATION_CATEGORY_IDS,
  type NotificationCategory,
  type NotificationCategoryId,
} from "../lib/notification-category.js";
import { env } from "../config/env.js";

export { LOGIN_DETECTED_TYPE };

/**
 * "Not yet resolved". Written as an explicit OR rather than the shorter
 * `loginResolvedAt: null` because rows created before this column existed have
 * the field ABSENT, not null — and a login alert from before the deploy must
 * still be actionable. `isSet: false` is the only filter that reaches those.
 */
const PENDING_LOGIN: Record<string, unknown> = {
  OR: [{ loginResolvedAt: null }, { loginResolvedAt: { isSet: false } }],
};

/**
 * A login-detected notification is one shared document per login event, fanned
 * out to every OTHER active session. The device that just logged in must never
 * see its own alert — in the list, the counts, or the badge — so every read
 * path excludes the row whose `loginSessionId` is the viewer's own current
 * session, regardless of who else it's visible to.
 *
 * `loginSessionId` is a scalar mirror of payload.data.sessionId (set only for
 * "auth.security_new_login" rows, see create() below) rather than a JSON-path
 * query, because MongoDB's Prisma JSON `path` filter can't be combined with
 * NOT/OR/AND — confirmed at runtime ("Unknown argument `path`") — it only
 * works as a bare top-level predicate.
 *
 * MUST be `{ isSet: false } OR { not: viewerSessionId }`, not a bare
 * `{ not: viewerSessionId }` — confirmed by direct testing against the live
 * DB: Prisma's Mongo `$expr`-compiled `not` filter does NOT match documents
 * where the field is entirely absent (as every notification created before
 * this column existed is), only documents where it's explicitly `null`/set.
 * A bare `not` filter silently hid every pre-existing notification, not just
 * login-detected ones — this is the fixed, verified-safe form.
 */
function excludeSelfLoginWhere(
  viewerSessionId?: string | null
): Record<string, unknown> {
  if (!viewerSessionId) return {};
  return {
    OR: [
      { loginSessionId: { isSet: false } },
      { loginSessionId: { not: viewerSessionId } },
    ],
  };
}

/**
 * ANDs multiple Prisma `where` fragments without key collisions — two
 * fragments both using a top-level `OR` (e.g. excludeSelfLoginWhere +
 * a SYSTEM/FRIENDS categoryWhere) would silently clobber each other if
 * object-spread together, since the later spread's `OR` key overwrites
 * the earlier one.
 */
function combineWhere(
  ...fragments: Record<string, unknown>[]
): Record<string, unknown> {
  const nonEmpty = fragments.filter((f) => Object.keys(f).length > 0);
  if (nonEmpty.length === 0) return {};
  if (nonEmpty.length === 1) return nonEmpty[0];
  return { AND: nonEmpty };
}

export class NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    actorId: string;
    type: string;
    [key: string]: unknown;
  }): Promise<Notification> {
    let payload = (data.payload as object) ?? {};
    const isLogin = data.type === LOGIN_DETECTED_TYPE;
    // Mirror payload.data.sessionId to the scalar loginSessionId column so
    // excludeSelfLoginWhere can filter on it (see the comment above) — only
    // meaningful for login-detected rows, null for every other type.
    const sessionId = isLogin
      ? ((payload as { data?: Record<string, string> }).data?.sessionId ?? null)
      : null;

    // Server-computed action deadline for Login Detected rows. Also mirrored
    // into payload.data.expiresAt (epoch ms as a string, matching the rest of
    // that string→string context bag) because BOTH read paths — the REST
    // serializer and the gRPC list — already ship `payload.data` verbatim, so
    // clients get the deadline with no wire-contract change. Clients may only
    // READ it: nothing here is taken from the inbound payload.
    const loginExpiresAt = isLogin
      ? new Date(Date.now() + env.LOGIN_DETECTION_TIMEOUT_MS)
      : null;
    if (loginExpiresAt) {
      const p = payload as { data?: Record<string, string> };
      payload = {
        ...p,
        data: {
          ...(p.data ?? {}),
          expiresAt: String(loginExpiresAt.getTime()),
        },
      };
    }

    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        actorId: data.actorId,
        type: data.type,
        entity: (data.entity as object) ?? {},
        actorSnapshot: (data.actorSnapshot as object) ?? {},
        payload,
        loginSessionId: sessionId,
        loginExpiresAt,
        loginResolvedAt: null,
        groupKey: (data.groupKey as string | null) ?? null,
        version: 1,
        isRead: (data.isRead as boolean) ?? false,
        readAt: (data.readAt as Date) ?? null,
        isDeleted: (data.isDeleted as boolean) ?? false,
        deletedAt: (data.deletedAt as Date) ?? null,
      },
    });
  }

  async findByUserId(
    userId: string,
    params: {
      limit: number;
      cursor?: string | null;
      /**
       * Extra Prisma `where` fragment (e.g. category filter). Merged into
       * the base userId/isDeleted/cursor predicate — kept optional so
       * existing callers (gRPC list, tests) are unaffected.
       */
      where?: Record<string, unknown>;
      /** The requesting device's own session id — see excludeSelfLoginWhere. */
      viewerSessionId?: string | null;
    }
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        userId,
        isDeleted: false,
        ...(params.cursor
          ? { createdAt: { lt: new Date(params.cursor) } }
          : {}),
        ...combineWhere(
          excludeSelfLoginWhere(params.viewerSessionId),
          params.where ?? {}
        ),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
  }

  /** Owner-scoped bulk mark-read. One query regardless of id count. */
  async markManyRead(
    notificationIds: string[],
    userId: string
  ): Promise<number> {
    if (notificationIds.length === 0) return 0;
    const result = await this.prisma.notification.updateMany({
      where: { id: { in: notificationIds }, userId, isRead: false },
      data: { isRead: true, readAt: new Date(), version: { increment: 1 } },
    });
    return result.count;
  }

  async markRead(
    notificationId: string,
    userId: string
  ): Promise<Notification | null> {
    // Scope the update to the owner so one user can't flip another user's
    // notification (IDOR). updateMany lets us filter by both id AND userId;
    // a non-owning id matches 0 rows and returns null without mutating.
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date(), version: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
  }

  /**
   * Bulk mark-read. `extraWhere` is an optional Prisma fragment (e.g. the
   * `categoryWhere("COMMUNITIES")` output from `lib/notification-category`) so
   * the Notification Center's per-tab "Read All" only flips rows belonging to
   * the currently-open tab. Omit or pass `undefined` for the historical
   * mark-everything behaviour.
   *
   * `before` (optional watermark): only rows with `createdAt <= before` are
   * marked — so a notification that arrives while the panel is open stays
   * unread (spec §9.2).
   */
  async markAllRead(
    userId: string,
    extraWhere?: Record<string, unknown>,
    before?: Date | null
  ): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
        ...(before ? { createdAt: { lte: before } } : {}),
        ...(extraWhere ?? {}),
      },
      data: { isRead: true, readAt: new Date(), version: { increment: 1 } },
    });
  }

  async getUnreadCount(
    userId: string,
    viewerSessionId?: string | null
  ): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        isRead: false,
        isDeleted: false,
        ...excludeSelfLoginWhere(viewerSessionId),
      },
    });
  }

  /**
   * TOTAL rows the user can see in one tab — read and unread alike.
   *
   * Distinct from `countByCategories`, which is unread-only because it drives
   * the header badges. The list endpoint needs this one instead: feeding an
   * unread count into `pagination.totalData` reported `totalData: 0` /
   * `totalPage: 0` for any tab whose rows had all been read, while the same
   * response still returned rows and `hasMore: true`.
   *
   * Same `(userId, type)` index and the same self-login exclusion as the list
   * query, so the number always describes exactly the rows that query returns.
   */
  async countByUserId(
    userId: string,
    category: NotificationCategory = "ALL",
    viewerSessionId?: string | null
  ): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        isDeleted: false,
        ...combineWhere(
          excludeSelfLoginWhere(viewerSessionId),
          categoryWhere(category)
        ),
      },
    });
  }

  /**
   * Per-category UNREAD counts for the Notification Center header badges. One
   * parallel count per bucket — cheaper than a groupBy round-trip on Mongo, and
   * each predicate hits the `(userId, type)` index. Unread-only so the badge
   * decrements live as the user reads rows; the list-page invalidation on
   * `markRead` / `markAllRead` triggers the refetch.
   *
   * The buckets are disjoint (see `categorizeId`), so `byId` sums to `all` — a
   * row can never be counted under two categories.
   *
   * Two shapes on purpose. The flat lowercase keys are what released clients
   * read and are frozen; `byId` is keyed on the catalogue ids the chips are
   * built from, so a client can look a count up by the id the catalogue gave it
   * instead of carrying its own id→legacy-name table. Counts are derived from
   * `type` alone and are NEVER filtered by the catalogue: a category disabled
   * for a platform still counts, and its rows still list under ALL.
   */
  async countByCategories(
    userId: string,
    viewerSessionId?: string | null
  ): Promise<{
    all: number;
    friends: number;
    communities: number;
    mentions: number;
    calls: number;
    system: number;
    liveNow: number;
    byId: Record<NotificationCategoryId, number>;
  }> {
    const selfExclusion = excludeSelfLoginWhere(viewerSessionId);
    const base = { userId, isDeleted: false, isRead: false };
    const countFor = (cat: Parameters<typeof categoryWhere>[0]) =>
      this.prisma.notification.count({
        where: {
          ...base,
          ...combineWhere(selfExclusion, categoryWhere(cat)),
        },
      });
    const [all, ...perCategory] = await Promise.all([
      countFor("ALL"),
      ...NOTIFICATION_CATEGORY_IDS.map(countFor),
    ]);
    const byId = Object.fromEntries(
      NOTIFICATION_CATEGORY_IDS.map((id, index) => [id, perCategory[index] ?? 0])
    ) as Record<NotificationCategoryId, number>;
    return {
      all,
      friends: byId.FRIEND_REQUEST,
      // Frozen key: a released client asking for the "Communities" tab counts
      // the same rows `?type=COMMUNITIES` lists, and that filter excludes
      // livestream rows now that LIVE_NOW owns them.
      communities: byId.COMMUNITY,
      mentions: byId.MENTION,
      calls: byId.CALLS,
      system: byId.SYSTEM,
      liveNow: byId.LIVE_NOW,
      byId,
    };
  }

  async deleteById(
    notificationId: string,
    userId: string
  ): Promise<{ count: number }> {
    // Owner-scoped soft-delete (IDOR-safe, mirrors markRead): updateMany filters
    // by id AND userId, so a non-owning id matches 0 rows and mutates nothing.
    // isDeleted:false keeps re-deletes idempotent (a second call matches 0 rows).
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, isDeleted: false },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });
    return { count: result.count };
  }

  /**
   * Owner-scoped soft-delete of EVERY still-active row in one notification
   * group, returning the ids that actually changed so each can be relayed.
   *
   * A terminal event has to clear the whole group, not just its newest card.
   * `findActiveByGroupKey` returns a single row, so deleting only that one left
   * every OLDER card of the same friendship behind — after a couple of
   * request/resolve cycles on the same recycled friendship id, withdrawing a
   * request removed the fresh "X sent you a friend request" card and left the
   * previous cycle's "You declined this friend request" sitting in the list
   * forever, with no button on it to remove it.
   */
  async deleteActiveByGroupKey(
    userId: string,
    groupKey: string
  ): Promise<{ ids: string[] }> {
    const where = { userId, groupKey, isDeleted: false };
    const rows = await this.prisma.notification.findMany({
      where,
      select: { id: true },
    });
    if (rows.length === 0) return { ids: [] };
    await this.prisma.notification.updateMany({
      where,
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });
    return { ids: rows.map((r) => r.id) };
  }

  async findByEntityId(
    userId: string,
    type: string,
    entityId: string
  ): Promise<Notification | null> {
    // Prisma MongoDB supports filtering on JSON path
    return this.prisma.notification.findFirst({
      where: {
        userId,
        type,
        entity: { path: ["id"], equals: entityId },
      },
    });
  }

  async findCollapsible(
    userId: string,
    type: string,
    entityId: string
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: {
        userId,
        type,
        isRead: false,
        isDeleted: false,
        entity: { path: ["id"], equals: entityId },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async collapseInto(
    id: string,
    data: {
      actorId: string;
      actorSnapshot: object;
      payload: object;
    }
  ): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: { ...data, createdAt: new Date() },
    });
  }

  async findByNewLoginSessionId(
    userId: string,
    sessionId: string
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: {
        userId,
        type: "auth.security_new_login",
        isDeleted: false,
        loginSessionId: sessionId,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByTypeAndActor(
    userId: string,
    type: string,
    actorId: string
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: { userId, type, actorId, isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Every login-detected row that is still PENDING (never actioned) and whose
   * server-stamped deadline has passed. Ordered oldest-first so a backlog after
   * downtime drains in creation order.
   *
   * `loginExpiresAt: { not: null, lte: now }` — the `not: null` half is load
   * bearing, NOT redundant: on MongoDB a bare `lte` also matches rows where the
   * field is absent, which would sweep in every login row created before this
   * column existed and resolve it instantly. `not` does not match absent
   * fields, so those legacy rows stay untouched (exactly as they behave today).
   */
  async findExpiredPendingLogins(
    now: Date,
    limit: number
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        type: LOGIN_DETECTED_TYPE,
        isDeleted: false,
        ...PENDING_LOGIN,
        loginExpiresAt: { not: null, lte: now },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  /**
   * Persists a user-initiated action on a notification (e.g. "TERMINATE" session,
   * "CONFIRM" login). Merges `actionTaken` into `payload.data`, updates `payload.body`,
   * and marks the row read in one write. Owner-scoped (IDOR-safe).
   *
   * EXCEPT for login-detected rows, whose `payload.body` is left ALONE: their
   * status has exactly one home, `data.actionTaken`, which every client renders
   * in the viewer's own language ("This was you." / "Session terminated.").
   * Writing that same status over the body as well cost the row its original
   * "New login detected on …" description AND made the UI print the status
   * twice — once as the body, once as the resolved line. `body` is still
   * accepted (and honoured) for every other type, so no caller breaks.
   *
   * For login-detected rows this is also the single state transition:
   * PENDING → APPROVED/TERMINATED, and nothing else. The `loginResolvedAt: null`
   * filter on the claim makes it exactly-once across every writer — the user on
   * device A, the user on device B, and the expiry sweep on any node — so a tap
   * landing at the same moment as the deadline yields one winner and one final
   * state. The loser gets null (already resolved), which every caller treats as
   * a no-op. Returns null for a not-found / not-owned / already-resolved row.
   */
  async recordAction(
    id: string,
    userId: string,
    body: string,
    action: string
  ): Promise<Notification | null> {
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId, isDeleted: false },
    });
    if (!existing) return null;
    const isLogin = existing.type === LOGIN_DETECTED_TYPE;
    if (isLogin) {
      const claim = await this.prisma.notification.updateMany({
        where: { id, userId, isDeleted: false, ...PENDING_LOGIN },
        data: { loginResolvedAt: new Date() },
      });
      if (claim.count === 0) return null; // someone already resolved it
    }
    const existingPayload = (existing.payload ?? {}) as {
      title?: string;
      body?: string;
      data?: Record<string, string>;
    };
    const updatedPayload = {
      ...existingPayload,
      ...(isLogin ? {} : { body }),
      data: { ...(existingPayload.data ?? {}), actionTaken: action },
    };
    return this.prisma.notification.update({
      where: { id },
      data: {
        payload: updatedPayload,
        isRead: true,
        readAt: new Date(),
        version: { increment: 1 },
      },
    });
  }

  async updatePayloadAndType(
    id: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<Notification | null> {
    return this.prisma.notification.update({
      where: { id },
      data: { type, payload: payload as object, version: { increment: 1 } },
    });
  }

  async findActiveByGroupKey(
    userId: string,
    groupKey: string
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: { userId, groupKey, isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  }

  async applyStateTransition(
    id: string,
    data: {
      type: string;
      actorId: string;
      actorSnapshot: object;
      entity: object;
      payload: object;
      resurface: boolean;
    }
  ): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: {
        type: data.type,
        actorId: data.actorId,
        actorSnapshot: data.actorSnapshot,
        entity: data.entity,
        payload: data.payload,
        version: { increment: 1 },
        ...(data.resurface ? { isRead: false, readAt: null } : {}),
      },
    });
  }

  async findUpdatedSince(
    userId: string,
    since: Date,
    params: { limit: number; viewerSessionId?: string | null }
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        userId,
        updatedAt: { gt: since },
        ...excludeSelfLoginWhere(params.viewerSessionId),
      },
      orderBy: { updatedAt: "asc" },
      take: params.limit,
    });
  }
}
