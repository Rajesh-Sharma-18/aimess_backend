import type { PrismaClient, Notification } from "../generated/prisma/index.js";
import { categoryWhere } from "../lib/notification-category.js";

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
    const payload = (data.payload as object) ?? {};
    // Mirror payload.data.sessionId to the scalar loginSessionId column so
    // excludeSelfLoginWhere can filter on it (see the comment above) — only
    // meaningful for login-detected rows, null for every other type.
    const sessionId =
      data.type === "auth.security_new_login"
        ? ((payload as { data?: Record<string, string> }).data?.sessionId ??
          null)
        : null;
    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        actorId: data.actorId,
        type: data.type,
        entity: (data.entity as object) ?? {},
        actorSnapshot: (data.actorSnapshot as object) ?? {},
        payload,
        loginSessionId: sessionId,
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

  async countByUserId(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isDeleted: false },
    });
  }

  /**
   * Per-tab UNREAD counts for the Notification Center header badges. Five
   * parallel counts (one per tab) — cheaper than a groupBy round-trip on
   * Mongo, and each predicate hits the `(userId, type)` index. Unread-only
   * so the badge decrements live as the user reads rows; the list-page
   * invalidation on `markRead` / `markAllRead` triggers the refetch.
   */
  async countByCategories(
    userId: string,
    viewerSessionId?: string | null
  ): Promise<{
    all: number;
    friends: number;
    communities: number;
    mentions: number;
    system: number;
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
    const [all, friends, communities, mentions, system] = await Promise.all([
      countFor("ALL"),
      countFor("FRIENDS"),
      countFor("COMMUNITIES"),
      countFor("MENTIONS"),
      countFor("SYSTEM"),
    ]);
    return { all, friends, communities, mentions, system };
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
   * Persists a user-initiated action on a notification (e.g. "TERMINATE" session,
   * "CONFIRM" login). Merges `actionTaken` into `payload.data`, updates `payload.body`,
   * and marks the row read in one write. Owner-scoped (IDOR-safe).
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
    const existingPayload = (existing.payload ?? {}) as {
      title?: string;
      body?: string;
      data?: Record<string, string>;
    };
    const updatedPayload = {
      ...existingPayload,
      body,
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
