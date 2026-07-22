/**
 * Telegram-style community history access + personal system-message visibility.
 *
 * Covers two requirements:
 *  1. PUBLIC communities let non-members read message history; PRIVATE communities
 *     block non-members with CHAT_NOT_A_MEMBER. BANNED members hit a READ CUTOFF on
 *     every read call site (message history, search, media, changes feed): history
 *     up to their `bannedAt` stays fully readable, nothing after it is ever
 *     returned — a ban is a WRITE/realtime block, not a read hard-block. Only a
 *     caller that omits `allowBannedReadCutoff` (none of the current read paths do)
 *     would see USER_BANNED instead.
 *  2. The "You joined the community" SYSTEM message is PERSONAL: persisted with a
 *     `visibleToUserId`, published to `user:<id>` (not the community room), and never
 *     surfaced to other members.
 */
import { ForbiddenError } from "@aimess/errors";

import { assertCommunityReadAccess } from "../../src/lib/access-guard.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { CommunityPinService } from "../../src/services/community-pin.service.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";
import { PERSONAL_JOIN_SESSION_TYPES } from "@aimess/constants";

/** Role authorization for CommunityPinService.pin/unpin is sourced LIVE from
 *  community-service, not RoomMember.role — see access-guard.ts
 *  assertCommunityRole/getCommunityLiveRole. Mirror the intended live role
 *  here so these tests exercise what they claim to, rather than relying on
 *  the global mock's ADMIN default (which happens to satisfy
 *  ["admin","moderator"] regardless of what `MOD`/`memberRepo` say below). */
function mockLiveRole(role: "ADMIN" | "MODERATOR" | "MEMBER" | ""): void {
  (getCommunityReconcileClient as jest.Mock).mockReturnValueOnce({
    checkCommunityMembership: jest.fn(async () => ({
      isMember: role !== "",
      isBanned: false,
      status: role !== "" ? "ACTIVE" : "",
      role,
    })),
  });
}

/**
 * Prime the authoritative gRPC verdict to say "genuinely not a member" for
 * tests modeling a PRIVATE non-member. The stale-mirror reconciliation added to
 * assertCommunityReadAccess (fixes the join-request-approved → 403 race by
 * doing an authoritative live-check on the private-community miss path) only
 * denies when the AUTHORITATIVE store also confirms non-member — otherwise the
 * default mock's `isMember: true` would heal the mirror and let the read
 * through, invalidating the assertion.
 */
function mockLiveNotMember(): void {
  (getCommunityReconcileClient as jest.Mock).mockReturnValueOnce({
    checkCommunityMembership: jest.fn(async () => ({
      isMember: false,
      isBanned: false,
      status: "LEFT",
      role: "",
    })),
  });
}

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Community-aware in-memory emulator for `findByRoomIdTimeline`. Visibility is
// now filtered in the DB via `timelineMatch` ($in/$nin/$nor + (createdAt,_id)
// keyset), so a findMany-only mock no longer exercises it. This emulator applies
// the exact aggregateRaw operators the keyset path emits ($oid/$date/$in/$nin/
// $nor/$or, createdAt+_id range, $sort, $limit) so these visibility regressions
// run through the REAL repo and assert on `result.messages`.
// ---------------------------------------------------------------------------
type EmuRow = {
  id: string;
  deletedBy?: string[];
  visibleToUserId?: string | null;
  systemMessageType?: string | null;
  [k: string]: unknown;
};

function dateMsOf(v: { $date: string }): number {
  return new Date(v.$date).getTime();
}

function emuMatchField(
  doc: Record<string, unknown>,
  key: string,
  cond: unknown
): boolean {
  if (key === "$or")
    return (cond as Array<Record<string, unknown>>).some((s) =>
      emuMatchDoc(doc, s)
    );
  if (key === "$and")
    return (cond as Array<Record<string, unknown>>).every((s) =>
      emuMatchDoc(doc, s)
    );
  if (key === "$nor")
    return !(cond as Array<Record<string, unknown>>).some((s) =>
      emuMatchDoc(doc, s)
    );
  const value = doc[key];
  if (cond === null || typeof cond !== "object") return value === cond;
  const c = cond as Record<string, unknown>;
  if ("$oid" in c) return value === (c as { $oid: string }).$oid;
  if ("$date" in c)
    return value instanceof Date && value.getTime() === dateMsOf(c as never);
  if ("$ne" in c)
    return Array.isArray(value) ? !value.includes(c.$ne) : value !== c.$ne;
  if ("$in" in c)
    return (c.$in as Array<string | null>).some((a) =>
      a === null ? value == null : value === a
    );
  if ("$eq" in c) {
    const against = c.$eq;
    if (against && typeof against === "object" && "$oid" in against) {
      return value === (against as { $oid: string }).$oid;
    }
    return value === against;
  }
  if ("$nin" in c)
    return !(c.$nin as string[]).includes((value as string) ?? "");
  // Range ops on createdAt (date) / _id (oid).
  return Object.entries(c).every(([op, against]) => {
    if (
      against &&
      typeof against === "object" &&
      "$date" in (against as object)
    ) {
      const t = value instanceof Date ? value.getTime() : Number(value);
      const r = dateMsOf(against as { $date: string });
      return op === "$lt"
        ? t < r
        : op === "$lte"
          ? t <= r
          : op === "$gt"
            ? t > r
            : op === "$gte"
              ? t >= r
              : false;
    }
    if (
      against &&
      typeof against === "object" &&
      "$oid" in (against as object)
    ) {
      const r = (against as { $oid: string }).$oid;
      return op === "$eq"
        ? String(value) === r
        : op === "$lt"
          ? String(value) < r
          : op === "$gt"
            ? String(value) > r
            : false;
    }
    return false;
  });
}

function emuMatchDoc(
  doc: Record<string, unknown>,
  match: Record<string, unknown>
): boolean {
  return Object.entries(match).every(([k, v]) => emuMatchField(doc, k, v));
}

/** Build a community-timeline prisma mock from minimal rows. Each row gets a
 *  roomId (ROOM_ID), a strictly-decreasing createdAt by declaration index (so a
 *  newest-first page preserves declaration order), and defaulted delete flags. */
function makeCommunityPrisma(rows: EmuRow[]) {
  const base = 1_700_000_000_000;
  const docs = rows.map((r, i) => ({
    deletedForAll: false,
    deletedBy: r.deletedBy ?? [],
    visibleToUserId: r.visibleToUserId ?? null,
    systemMessageType: r.systemMessageType ?? null,
    ...r,
    _id: r.id,
    roomId: ROOM_ID,
    createdAt: new Date(base - i * 1000),
  })) as Array<Record<string, unknown>>;

  const aggregateRaw = jest.fn(async ({ pipeline }: { pipeline: any[] }) => {
    const match = pipeline.find((s) => "$match" in s)?.$match ?? {};
    let out = docs.filter((d) => emuMatchDoc(d, match));
    if (pipeline.find((s) => "$count" in s))
      return out.length ? [{ total: out.length }] : [];
    const sort = pipeline.find((s) => "$sort" in s)?.$sort as
      | Record<string, number>
      | undefined;
    if (sort) {
      const [[k1, d1], tie] = Object.entries(sort);
      const [k2, d2] = tie ?? [];
      out = [...out].sort((a, b) => {
        const av1 = k1 === "_id" ? a._id : (a.createdAt as Date).getTime();
        const bv1 = k1 === "_id" ? b._id : (b.createdAt as Date).getTime();
        if ((av1 as never) < (bv1 as never)) return -1 * d1;
        if ((av1 as never) > (bv1 as never)) return 1 * d1;
        if (!k2) return 0;
        const av2 = k2 === "_id" ? a._id : (a.createdAt as Date).getTime();
        const bv2 = k2 === "_id" ? b._id : (b.createdAt as Date).getTime();
        if ((av2 as never) < (bv2 as never)) return -1 * d2!;
        if ((av2 as never) > (bv2 as never)) return 1 * d2!;
        return 0;
      });
    }
    const limit = pipeline.find((s) => "$limit" in s)?.$limit as
      | number
      | undefined;
    if (limit != null) out = out.slice(0, limit);
    return out.map((d) => ({ _id: { $oid: d._id } }));
  });

  const findMany = jest.fn(
    async ({
      where,
      orderBy,
      take,
    }: {
      where: {
        id?: { in: string[] };
        roomId?: string;
        visibleToUserId?: string;
      };
      orderBy?: unknown;
      take?: number;
    }) => {
      if (!where.id) {
        let rows = docs.filter(
          (d) =>
            d.roomId === where.roomId &&
            d.visibleToUserId === where.visibleToUserId &&
            d.deletedForAll === false &&
            [...PERSONAL_JOIN_SESSION_TYPES].includes(
              d.systemMessageType as never
            )
        );
        if (orderBy) {
          rows = [...rows].sort((a, b) => {
            const t =
              (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
            return t || String(b._id).localeCompare(String(a._id));
          });
        }
        return rows.slice(0, take ?? rows.length).map((d) => ({ id: d._id }));
      }
      const want = new Set(where.id.in);
      return docs
        .filter((d) => want.has(d._id as string))
        .map((d) => ({ ...d, id: d._id }));
    }
  );

  return { generalRoomMessage: { aggregateRaw, findMany } };
}

describe("GeneralRoomMessageRepository personal-visibility filter", () => {
  it("findByRoomIdTimeline keeps field-absent/own messages, drops others' personal", async () => {
    const rows = [
      { id: "1", deletedBy: [] }, // legacy doc: no visibleToUserId field at all
      { id: "2", deletedBy: [], visibleToUserId: null }, // explicit null
      { id: "3", deletedBy: [], visibleToUserId: USER_ID }, // mine
      { id: "4", deletedBy: [], visibleToUserId: OTHER_ID }, // someone else's
    ];
    const repo = new GeneralRoomMessageRepository(
      makeCommunityPrisma(rows) as never
    );

    const { messages } = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
    });

    // field-absent + null + own-target kept; another user's personal dropped.
    // ($in:[null,user] matches field-absent docs natively in the keyset $match.)
    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("findLatestPersonalByRooms scopes the $match to the caller and decodes extended-JSON", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([
      {
        _id: { $oid: ROOM_ID },
        message: "You joined the community",
        createdAt: { $date: "2026-06-20T10:05:00.000Z" },
      },
    ]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const map = await repo.findLatestPersonalByRooms({
      userId: USER_ID,
      roomIds: [ROOM_ID],
    });

    // Keyed by room hex, with a real Date decoded from `{ $date }`.
    const entry = map.get(ROOM_ID);
    expect(entry?.message).toBe("You joined the community");
    expect(entry?.createdAt.toISOString()).toBe("2026-06-20T10:05:00.000Z");

    // The aggregation must restrict to the CALLER's own personal rows — never
    // another user's (the whole point of PERSONAL visibility).
    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    const match = pipeline.find(
      (s: Record<string, unknown>) => "$match" in s
    ).$match;
    expect(match.visibleToUserId).toBe(USER_ID);
    expect(match.roomId).toEqual({ $in: [{ $oid: ROOM_ID }] });
    expect(match.deletedForAll).toBe(false);
  });

  it("findLatestPersonalByRooms short-circuits with no rooms (no query)", async () => {
    const aggregateRaw = jest.fn();
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const map = await repo.findLatestPersonalByRooms({
      userId: USER_ID,
      roomIds: [],
    });

    expect(map.size).toBe(0);
    expect(aggregateRaw).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Membership-lifecycle join-line cleanup (Telegram parity): on leave/remove/
  // ban the user's PERSONAL join-session onboarding lines are hard-deleted so
  // they never accumulate across rejoin cycles.
  // -------------------------------------------------------------------------
  it("deletePersonalJoinMessages purges only the user's join-session lines, bounded by eventAt, and returns the deleted ids", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "stale-1" }]);
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { generalRoomMessage: { findMany, deleteMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const boundary = new Date(1_700_000_500_000);
    const ids = await repo.deletePersonalJoinMessages({
      roomId: ROOM_ID,
      userId: USER_ID,
      beforeOrAt: boundary,
    });

    // Returns the deleted ids (not just a count) so a caller can emit a
    // per-id `community:message:deleted` event for an already-connected client.
    expect(ids).toEqual(["stale-1"]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.roomId).toBe(ROOM_ID);
    // Scoped to the user's OWN personal rows only.
    expect(where.visibleToUserId).toBe(USER_ID);
    // Only the two join-session onboarding subtypes.
    expect(where.systemMessageType).toEqual({
      in: ["COMMUNITY_JOINED", "JOIN_REQUEST_APPROVED"],
    });
    // Bounded by the leave time so a redelivered stale "left" can't nuke a
    // fresher rejoin line.
    expect(where.createdAt).toEqual({ lte: boundary });
    // The actual delete targets exactly the ids just looked up.
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ["stale-1"] },
    });
  });

  it("deletePersonalJoinMessages omits the createdAt bound when no eventAt given", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { generalRoomMessage: { findMany, deleteMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const ids = await repo.deletePersonalJoinMessages({
      roomId: ROOM_ID,
      userId: USER_ID,
    });

    expect(ids).toEqual([]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
    // No stale rows found → deleteMany is skipped entirely (no-op DB call).
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("read guard hides a non-active member's OWN join line but keeps it for an active member", async () => {
    const rows = [
      {
        id: "join",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      { id: "msg", deletedBy: [], visibleToUserId: null }, // community-wide
    ];
    const makeRepo = () =>
      new GeneralRoomMessageRepository(makeCommunityPrisma(rows) as never);

    // Non-active member (left, still browsing PUBLIC history): own join line hidden.
    const left = await makeRepo().findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: false,
    });
    expect(left.messages.map((m) => m.id)).toEqual(["msg"]);

    // Active member: own current-session join line is visible.
    const active = await makeRepo().findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
    });
    expect(active.messages.map((m) => m.id)).toEqual(["join", "msg"]);
  });

  // -------------------------------------------------------------------------
  // Suppressed moderation lines (removed) are hidden from EVERYONE — including
  // active members. MEMBER_BANNED is now PERSONAL (Telegram parity: the banned
  // user themselves gets a private "You were banned…" line); a viewer who
  // ISN'T the target still never sees it.
  // -------------------------------------------------------------------------
  it("hides the SILENT moderation/lifecycle lines (left/joined/removed); shows MEMBER_BANNED only to its target; unbanned stays visible — Telegram parity", async () => {
    const rows = [
      // Hidden: removal must be SILENT from the chat-message perspective —
      // the affected user learns via `community:membership:removed` instead.
      { id: "removed", deletedBy: [], systemMessageType: "MEMBER_REMOVED" },
      // PERSONAL: visible to its target (this viewer), not to anyone else.
      {
        id: "banned",
        deletedBy: [],
        systemMessageType: "MEMBER_BANNED",
        visibleToUserId: USER_ID,
      },
      // PERSONAL, but targeted at someone else — never visible to this viewer.
      {
        id: "banned-other",
        deletedBy: [],
        systemMessageType: "MEMBER_BANNED",
        visibleToUserId: "someone-else",
      },
      // Visible: informational moderation action (NOT in HIDDEN_SYSTEM_MESSAGE_TYPES).
      { id: "unbanned", deletedBy: [], systemMessageType: "MEMBER_UNBANNED" },
      // Hidden: voluntary-leave noise.
      { id: "left", deletedBy: [], systemMessageType: "MEMBER_LEFT" },
      // Hidden: legacy community-wide join line — would duplicate the personal
      // "You joined the community" (own row, would personalize to "You").
      {
        id: "joined",
        deletedBy: [],
        systemMessageType: "MEMBER_JOINED",
        visibleToUserId: null,
      },
      { id: "rolechg", deletedBy: [], systemMessageType: "ROLE_CHANGED" }, // not hidden
      { id: "msg", deletedBy: [] }, // regular message
    ];
    const repo = new GeneralRoomMessageRepository(
      makeCommunityPrisma(rows) as never
    );

    const { messages } = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
    });

    // left + joined + removed + the other user's ban line dropped; this
    // viewer's own ban line + unbanned + role change + message survive.
    expect(messages.map((m) => m.id)).toEqual([
      "banned",
      "unbanned",
      "rolechg",
      "msg",
    ]);
  });

  // -------------------------------------------------------------------------
  // MEMBER_MUTED / MEMBER_UNMUTED are PERSONAL (Telegram parity): only the
  // muted/unmuted member ever sees their own line via history/sync — never
  // other members, moderators, or admins, and never each other's lines. They
  // persist exactly like any other PERSONAL line (e.g. MEMBER_BANNED) and
  // remain available to the affected member after reload/reconnect.
  // -------------------------------------------------------------------------
  it("shows MEMBER_MUTED/MEMBER_UNMUTED only to their own target — never to other members, via the real history/sync read path", async () => {
    const rows = [
      // This viewer's own mute + unmute lines — visible to them, including
      // after a hard reload (persisted like any other PERSONAL line).
      {
        id: "muted-mine",
        deletedBy: [],
        systemMessageType: "MEMBER_MUTED",
        visibleToUserId: USER_ID,
      },
      {
        id: "unmuted-mine",
        deletedBy: [],
        systemMessageType: "MEMBER_UNMUTED",
        visibleToUserId: USER_ID,
      },
      // Another member's mute/unmute lines — never visible to this viewer,
      // even though they are an active member of the same community.
      {
        id: "muted-other",
        deletedBy: [],
        systemMessageType: "MEMBER_MUTED",
        visibleToUserId: OTHER_ID,
      },
      {
        id: "unmuted-other",
        deletedBy: [],
        systemMessageType: "MEMBER_UNMUTED",
        visibleToUserId: OTHER_ID,
      },
      { id: "msg", deletedBy: [] }, // regular message
    ];
    const repo = new GeneralRoomMessageRepository(
      makeCommunityPrisma(rows) as never
    );

    const viewer = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
    });
    expect(viewer.messages.map((m) => m.id)).toEqual([
      "muted-mine",
      "unmuted-mine",
      "msg",
    ]);

    // The other member reads the SAME room and sees only their own lines —
    // never USER_ID's mute/unmute lines.
    const otherViewer = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: OTHER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
    });
    expect(otherViewer.messages.map((m) => m.id)).toEqual([
      "muted-other",
      "unmuted-other",
      "msg",
    ]);
  });

  it("joiner with a legacy MEMBER_JOINED + personal COMMUNITY_JOINED sees exactly ONE join line (the duplicate fix)", async () => {
    const rows = [
      // Legacy community-wide join line (would personalize to "You joined…" for
      // the joiner) — the source of the duplicate.
      {
        id: "legacy-joined",
        deletedBy: [],
        visibleToUserId: null,
        systemMessageType: "MEMBER_JOINED",
      },
      // The current personal onboarding line.
      {
        id: "personal-joined",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      { id: "msg", deletedBy: [] },
    ];
    const repo = new GeneralRoomMessageRepository(
      makeCommunityPrisma(rows) as never
    );

    const { messages } = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
    });

    // Legacy MEMBER_JOINED hidden → exactly the single personal line survives.
    expect(messages.map((m) => m.id)).toEqual(["personal-joined", "msg"]);
    expect(
      messages.filter((m) =>
        ["MEMBER_JOINED", "COMMUNITY_JOINED"].includes(
          (m as { systemMessageType?: string }).systemMessageType ?? ""
        )
      )
    ).toHaveLength(1);
  });

  it("keeps only the newest personal join-session line for the same user", async () => {
    const rows = [
      {
        id: "new-personal-joined",
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      {
        id: "old-personal-joined",
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      { id: "msg" },
    ];
    const repo = new GeneralRoomMessageRepository(
      makeCommunityPrisma(rows) as never
    );

    const { messages } = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 20,
      viewerIsActiveMember: true,
    });

    expect(messages.map((m) => m.id)).toEqual(["new-personal-joined", "msg"]);
  });

  it("raw catch-up match excludes suppressed moderation types via $nin", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { generalRoomMessage: { aggregateRaw, findMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.findSinceId({
      roomId: ROOM_ID,
      userId: USER_ID,
      sinceId: "",
      limit: 20,
    });

    const match = aggregateRaw.mock.calls
      .map(
        (call) =>
          call[0].pipeline.find((s: Record<string, unknown>) => "$match" in s)
            ?.$match
      )
      .find((m) => m?.systemMessageType?.$nin);
    expect(match.systemMessageType).toEqual({
      $nin: ["MEMBER_LEFT", "MEMBER_JOINED", "MEMBER_REMOVED"],
    });
  });

  it("conversation count match excludes suppressed moderation types via $nin", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([{ total: 0 }]);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { generalRoomMessage: { aggregateRaw, findMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.countConversation({
      roomId: ROOM_ID,
      userId: USER_ID,
      beforeMs: 1_700_000_000_000,
    });

    const match = aggregateRaw.mock.calls
      .map((call) => call[0].pipeline[0].$match)
      .find((m) => m?.systemMessageType?.$nin);
    expect(match.systemMessageType).toEqual({
      $nin: ["MEMBER_LEFT", "MEMBER_JOINED", "MEMBER_REMOVED"],
    });
  });

  it("findUpdatedAtSince (incremental sync) includes the affected member's own MEMBER_MUTED/MEMBER_UNMUTED rows, excludes another member's", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]); // findLatestPersonalJoinMessageId
    const findMany = jest.fn().mockResolvedValue([
      {
        id: "muted-mine",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "MEMBER_MUTED",
      },
      {
        id: "unmuted-mine",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "MEMBER_UNMUTED",
      },
      {
        id: "muted-other",
        deletedBy: [],
        visibleToUserId: OTHER_ID,
        systemMessageType: "MEMBER_MUTED",
      },
      { id: "msg", deletedBy: [], visibleToUserId: null },
    ]);
    const prisma = { generalRoomMessage: { aggregateRaw, findMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const { messages } = await repo.findUpdatedAtSince({
      roomId: ROOM_ID,
      userId: USER_ID,
      fromTs: new Date(0),
      limit: 20,
    });

    expect(messages.map((m) => m.id)).toEqual([
      "muted-mine",
      "unmuted-mine",
      "msg",
    ]);
  });

  it("findLatestPersonalByRooms (community-list personal lastActivity overlay) surfaces the affected member's own MEMBER_MUTED/MEMBER_UNMUTED row", async () => {
    const aggregateRaw = jest
      .fn()
      .mockResolvedValue([
        { _id: { $oid: ROOM_ID }, message: "You were unmuted", createdAt: {} },
      ]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.findLatestPersonalByRooms({
      userId: USER_ID,
      roomIds: [ROOM_ID],
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    // Scoped to this viewer's own PERSONAL rows only — no type-based exclusion
    // (MEMBER_MUTED/MEMBER_UNMUTED persist like any other PERSONAL line).
    expect(match.visibleToUserId).toBe(USER_ID);
    expect(match.systemMessageType).toBeUndefined();
  });

  it("bulk unread count excludes ALL system messages (any systemMessageType) via $in:[null]", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.countUnreadBulk({
      userId: USER_ID,
      thresholds: [{ roomId: ROOM_ID, afterDate: new Date(0) }],
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    // Unread counting excludes every SYSTEM message, not just the suppressed
    // moderation subset (see shouldCountInUnread policy) — any doc with a
    // systemMessageType at all is excluded via $in:[null].
    expect(match.systemMessageType).toEqual({ $in: [null] });
  });
});

// ---------------------------------------------------------------------------
// assertCommunityReadAccess — PUBLIC vs PRIVATE membership rules. The community
// visibility is read from the GeneralRoom (`communityType`), only for non-members.
// ---------------------------------------------------------------------------
describe("assertCommunityReadAccess", () => {
  const makeMemberRepo = (status: string | null) => ({
    findByRoomAndUser: jest
      .fn()
      .mockResolvedValue(status === null ? null : { status, role: "member" }),
  });
  const makeRoomRepo = (communityType: string | null) => ({
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: "active", communityType }),
  });

  it("allows an ACTIVE member without loading the room", async () => {
    const roomRepo = makeRoomRepo("PRIVATE");
    const res = await assertCommunityReadAccess(
      roomRepo as never,
      makeMemberRepo("active") as never,
      ROOM_ID,
      USER_ID
    );
    expect(res.canRead).toBe(true);
    expect(res.member).not.toBeNull();
    // Members short-circuit — the room (visibility) is never loaded.
    expect(roomRepo.findRoomById).not.toHaveBeenCalled();
  });

  it("allows a NON-member to read a PUBLIC community", async () => {
    const res = await assertCommunityReadAccess(
      makeRoomRepo("PUBLIC") as never,
      makeMemberRepo(null) as never,
      ROOM_ID,
      USER_ID
    );
    expect(res.canRead).toBe(true);
    expect(res.member).toBeNull();
  });

  it("blocks a NON-member from a PRIVATE community", async () => {
    mockLiveNotMember();
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo("PRIVATE") as never,
        makeMemberRepo(null) as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("fails closed (blocks) when the room's communityType is unsynced (null)", async () => {
    mockLiveNotMember();
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo(null) as never,
        makeMemberRepo(null) as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a BANNED user with USER_BANNED — even when the community is PUBLIC (the ban outranks the public-read fallback)", async () => {
    const roomRepo = makeRoomRepo("PUBLIC");
    await expect(
      assertCommunityReadAccess(
        roomRepo as never,
        makeMemberRepo("banned") as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toMatchObject({ message: "USER_BANNED" });
    // Denied on the membership row alone — never falls through to the
    // PUBLIC non-member branch (an existing-but-banned member isn't one).
    expect(roomRepo.findRoomById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // `allowBannedReadCutoff` — the read-cutoff opt-in. Every current READ call
  // site sets it; a banned member gets canRead=true + bannedAtCutoff instead
  // of throwing, so history up to their ban stays readable (a ban is a
  // WRITE/realtime block, not a read hard-block — see the doc on this function).
  // -------------------------------------------------------------------------
  it("allowBannedReadCutoff: a BANNED member gets canRead=true + bannedAtCutoff instead of throwing", async () => {
    const bannedAt = new Date("2026-07-01T00:00:00.000Z");
    const memberRepo = {
      findByRoomAndUser: jest
        .fn()
        .mockResolvedValue({ status: "banned", role: "member", bannedAt }),
    };
    const res = await assertCommunityReadAccess(
      makeRoomRepo("PUBLIC") as never,
      memberRepo as never,
      ROOM_ID,
      USER_ID,
      { allowBannedReadCutoff: true }
    );
    expect(res.canRead).toBe(true);
    expect(res.member?.status).toBe("banned");
    expect(res.bannedAtCutoff).toEqual(bannedAt);
  });

  it("allowBannedReadCutoff: still rejects a non-member of a PRIVATE community (the option only changes BANNED handling)", async () => {
    mockLiveNotMember();
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo("PRIVATE") as never,
        makeMemberRepo(null) as never,
        ROOM_ID,
        USER_ID,
        { allowBannedReadCutoff: true }
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// CommunityMessageService.getMessages — routes through the read-access guard
// ---------------------------------------------------------------------------
describe("CommunityMessageService.getMessages access", () => {
  function build(memberStatus: string | null, communityType: string | null) {
    const messageRepo = {
      findByRoomIdWithTime: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = {
      findRoomById: jest
        .fn()
        .mockResolvedValue({ id: ROOM_ID, status: "active", communityType }),
    };
    const memberRepo = {
      findByRoomAndUser: jest
        .fn()
        .mockResolvedValue(
          memberStatus === null
            ? null
            : { status: memberStatus, role: "member" }
        ),
      findReadStatusByRoom: jest.fn().mockResolvedValue([]),
    };
    const cacheRepo = {};
    const userSnapshotService = {};
    const service = new CommunityMessageService(
      messageRepo as never,
      roomRepo as never,
      memberRepo as never,
      cacheRepo as never,
      userSnapshotService as never
    );
    return { service, messageRepo };
  }

  it("non-member can read a PUBLIC community history", async () => {
    const { service, messageRepo } = build(null, "PUBLIC");
    await expect(
      service.getMessages({ roomId: ROOM_ID, userId: USER_ID, limit: 30 })
    ).resolves.toEqual([]);
    expect(messageRepo.findByRoomIdWithTime).toHaveBeenCalled();
  });

  it("non-member is blocked from a PRIVATE community history", async () => {
    mockLiveNotMember();
    const { service, messageRepo } = build(null, "PRIVATE");
    await expect(
      service.getMessages({ roomId: ROOM_ID, userId: USER_ID, limit: 30 })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(messageRepo.findByRoomIdWithTime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Read axis: getConversation / listMedia apply the BANNED read cutoff — the
// page/media list is capped at bannedAt instead of throwing. A LEFT/non-member
// of a PRIVATE community is still blocked with CHAT_NOT_A_MEMBER (unaffected —
// that's the non-member branch, not the banned one).
// ---------------------------------------------------------------------------
describe("CommunityMessageService.getConversation / listMedia — banned read cutoff", () => {
  const BANNED_AT = new Date("2026-07-01T00:00:00.000Z");

  function build(memberStatus: string | null, communityType: string | null) {
    const messageRepo = {
      listConversationMessages: jest.fn().mockResolvedValue([]),
      countConversation: jest.fn().mockResolvedValue(0),
      listMedia: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = {
      findRoomById: jest
        .fn()
        .mockResolvedValue({ id: ROOM_ID, status: "active", communityType }),
    };
    const memberRepo = {
      findByRoomAndUser: jest.fn().mockResolvedValue(
        memberStatus === null
          ? null
          : {
              status: memberStatus,
              role: "member",
              bannedAt: memberStatus === "banned" ? BANNED_AT : null,
            }
      ),
      advanceReadPointer: jest.fn().mockResolvedValue(undefined),
    };
    const cacheRepo = {};
    const userSnapshotService = {};
    const service = new CommunityMessageService(
      messageRepo as never,
      roomRepo as never,
      memberRepo as never,
      cacheRepo as never,
      userSnapshotService as never
    );
    return { service, messageRepo, memberRepo };
  }

  it("getConversation caps a BANNED member's page at bannedAt instead of throwing — no read-pointer write", async () => {
    const { service, messageRepo, memberRepo } = build("banned", "PRIVATE");

    await expect(
      service.getConversation({
        roomId: ROOM_ID,
        userId: USER_ID,
        pageNumber: 1,
        limit: 30,
        timestamp: BANNED_AT.getTime() + 60_000, // request a window PAST the ban
      })
    ).resolves.toEqual({ messages: [], total: 0 });

    // beforeMs must be clamped to bannedAt, never the later requested timestamp.
    expect(messageRepo.listConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMs: BANNED_AT.getTime() })
    );
    expect(messageRepo.countConversation).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMs: BANNED_AT.getTime() })
    );
    // Read state is a member-only concept — a banned (non-active) viewer never
    // advances the read pointer, even on a successful capped read.
    expect(memberRepo.advanceReadPointer).not.toHaveBeenCalled();
  });

  it("getConversation still advances the read pointer for an ACTIVE member", async () => {
    const { service, messageRepo, memberRepo } = build("active", "PRIVATE");
    (messageRepo.listConversationMessages as jest.Mock).mockResolvedValue([
      { id: "m1", createdAt: new Date() },
    ]);

    await service.getConversation({
      roomId: ROOM_ID,
      userId: USER_ID,
      pageNumber: 1,
      limit: 30,
    });

    expect(memberRepo.advanceReadPointer).toHaveBeenCalled();
  });

  it("getConversation blocks a non-member of a PRIVATE community", async () => {
    mockLiveNotMember();
    const { service } = build(null, "PRIVATE");
    await expect(
      service.getConversation({
        roomId: ROOM_ID,
        userId: USER_ID,
        pageNumber: 1,
        limit: 30,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("listMedia allows a BANNED member, capped to media sent at/before bannedAt — even in a PUBLIC community", async () => {
    const { service, messageRepo } = build("banned", "PUBLIC");

    await expect(
      service.listMedia({ roomId: ROOM_ID, userId: USER_ID, limit: 20 })
    ).resolves.toEqual([]);

    expect(messageRepo.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoff: BANNED_AT })
    );
  });

  it("listMedia blocks a non-member of a PRIVATE community", async () => {
    mockLiveNotMember();
    const { service } = build(null, "PRIVATE");
    await expect(
      service.listMedia({ roomId: ROOM_ID, userId: USER_ID, limit: 20 })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// CommunitySystemMessageService — PERSONAL join message targeting
// ---------------------------------------------------------------------------
describe("CommunitySystemMessageService PERSONAL join message", () => {
  function build() {
    const created = {
      id: "m".repeat(24),
      sentBy: USER_ID,
      senderName: "Bob",
      message: "You joined the community",
      messageType: "SYSTEM",
      createdAt: new Date(),
    };
    const messageRepo = {
      createSystemMessage: jest.fn().mockResolvedValue(created),
      findOne: jest.fn().mockResolvedValue(null),
      // Stale-join-line cleanup (rejoin dedup) runs before every personal
      // join-session insert — see CommunitySystemMessageService.postOne().
      deletePersonalJoinMessages: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = {
      allocateSequence: jest.fn().mockResolvedValue(1),
      allocateRevision: jest.fn().mockResolvedValue(1),
      allocateSequenceAndRevision: jest
        .fn()
        .mockResolvedValue({ sequenceNumber: 1, revision: 1 }),
      addLastestMessageToRoom: jest.fn().mockResolvedValue(undefined),
    };
    const cacheRepo = {};
    const userSnapshotService = {
      // Resolve every requested id → "Bob" so actor/target names interpolate.
      getUserSnapshotsMap: jest.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, { displayName: "Bob" }]))
      ),
    };
    const publish = jest.fn().mockResolvedValue(undefined);
    const redis = { publish };
    const service = new CommunitySystemMessageService(
      messageRepo as never,
      roomRepo as never,
      cacheRepo as never,
      userSnapshotService as never,
      redis as never
    );
    return { service, messageRepo, roomRepo, publish };
  }

  it("derives PERSONAL visibility from the registry → persists visibleToUserId + publishes to user:<id> only", async () => {
    const { service, messageRepo, roomRepo, publish } = build();

    // NOTE: no visibilityType passed — it's derived from SYSTEM_MESSAGE_VISIBILITY.
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "COMMUNITY_JOINED",
      metadata: {},
      triggeredByUserId: USER_ID,
      visibleToUserId: USER_ID,
    });

    expect(messageRepo.createSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibleToUserId: USER_ID })
    );
    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`user:${USER_ID}`);
    expect(channels).not.toContain(`community:${ROOM_ID}`);
    // PERSONAL + non-bumping subtype → no list reorder.
    expect(roomRepo.addLastestMessageToRoom).not.toHaveBeenCalled();
  });

  it("JOIN_REQUEST_APPROVED is also registry-PERSONAL (user channel)", async () => {
    const { service, publish } = build();
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "JOIN_REQUEST_APPROVED",
      metadata: {},
      triggeredByUserId: USER_ID,
      visibleToUserId: USER_ID,
    });
    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([`user:${USER_ID}`]);
  });

  it("COMMUNITY subtypes publish to the room and the wire is SENDER-LESS", async () => {
    const { service, roomRepo, publish } = build();

    // UNPINNED_MESSAGE: a COMMUNITY-visible, non-bumping subtype (MEMBER_JOINED is
    // now a hidden membership-lifecycle line, so it's no longer a good example).
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "UNPINNED_MESSAGE",
      metadata: {},
      triggeredByUserId: OTHER_ID,
    });

    const [channel, payload] = publish.mock.calls[0];
    expect(channel).toBe(`community:${ROOM_ID}`);
    const data = JSON.parse(payload).data;
    // Sender-less: no senderId / senderName / senderAvatar on a SYSTEM message.
    expect(data.senderId).toBe("");
    expect(data.senderName).toBe("");
    expect(data.senderAvatar).toBe("");
    expect(data.systemMessageType).toBe("UNPINNED_MESSAGE");
    expect(data.isPersonal).toBe(false);
    // Low-signal lines must not reorder the community list for other members.
    expect(roomRepo.addLastestMessageToRoom).not.toHaveBeenCalled();
  });

  it("renders deterministic Telegram-style template text per subtype", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["COMMUNITY_CREATED", {}, "Community created"],
      ["COMMUNITY_NAME_UPDATED", {}, "Community name updated"],
      ["COMMUNITY_DESCRIPTION_UPDATED", {}, "Community description updated"],
      ["COMMUNITY_AVATAR_UPDATED", {}, "Community photo updated"],
      ["COMMUNITY_BANNER_UPDATED", {}, "Community banner updated"],
      ["COMMUNITY_HANDLE_UPDATED", {}, "Community handle updated"],
      ["COMMUNITY_UPDATED", {}, "Community settings updated"],
      // NOTE: MEMBER_REMOVED / MEMBER_BANNED / MEMBER_LEFT / MEMBER_JOINED are
      // hidden membership lines — post() drops them, so they're not exercised here.
      [
        "ROLE_CHANGED",
        { targetUserId: OTHER_ID, newRole: "ADMIN", oldRole: "MEMBER" },
        "Bob is now the community admin",
      ],
      ["COMMUNITY_JOINED", {}, "You joined the community"],
      ["JOIN_REQUEST_APPROVED", {}, "Your request to join was approved"],
      ["JOIN_REQUEST_REJECTED", {}, "Your request to join was declined"],
    ];

    for (const [type, metadata, expected] of cases) {
      const { service, messageRepo } = build();
      // Snapshot resolves OTHER_ID → "Bob" so the target name interpolates.
      await service.post({
        communityId: ROOM_ID,
        systemMessageType: type as never,
        metadata,
        triggeredByUserId: OTHER_ID,
        visibleToUserId: OTHER_ID,
      });
      const arg = messageRepo.createSystemMessage.mock.calls[0][0];
      expect(arg.fallbackText).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Pin / unpin emit PINNED_MESSAGE / UNPINNED_MESSAGE SYSTEM lines
// ---------------------------------------------------------------------------
describe("Community pin/unpin → system messages", () => {
  const MOD = { status: "active", role: "admin" };
  const MSG_ID = "m".repeat(24);

  it("CommunityPinService.pin emits PINNED_MESSAGE", async () => {
    const postReturnId = jest.fn().mockResolvedValue("sys-1");
    const svc = new CommunityPinService(
      {
        findActivePinByRoom: jest.fn().mockResolvedValue(null),
        runTransaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
        createPin: jest.fn().mockResolvedValue({ id: "p" }),
        setPinSystemMessageId: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        findById: jest.fn().mockResolvedValue({
          id: MSG_ID,
          roomId: ROOM_ID,
          message: "hi",
          messageType: "TEXT",
          deletedForAll: false,
          createdAt: new Date(),
        }),
      } as never,
      {
        findRoomById: jest.fn().mockResolvedValue({
          id: ROOM_ID,
          name: "Test Community",
          status: "active",
        }),
        incPinnedCount: jest.fn().mockResolvedValue({ pinnedCount: 1 }),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      { postReturnId } as never
    );
    mockLiveRole("ADMIN");

    await svc.pin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      communityId: ROOM_ID,
    });

    expect(postReturnId).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM_ID,
        systemMessageType: "PINNED_MESSAGE",
        triggeredByUserId: USER_ID,
      })
    );
  });

  it("CommunityPinService.unpin does NOT emit a system message (soft-delete only, product requirement)", async () => {
    const postReturnId = jest.fn().mockResolvedValue("sys-1");
    const svc = new CommunityPinService(
      {
        findActivePinByMessageId: jest.fn().mockResolvedValue({
          id: "p",
          roomId: ROOM_ID,
          messageId: MSG_ID,
        }),
        softDeletePin: jest
          .fn()
          .mockResolvedValue({ id: "p", unpinnedAt: new Date() }),
      } as never,
      {} as never,
      {
        incPinnedCount: jest.fn().mockResolvedValue({ pinnedCount: 0 }),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      { postReturnId } as never
    );
    mockLiveRole("ADMIN");

    await svc.unpin({ roomId: ROOM_ID, messageId: MSG_ID, userId: USER_ID });

    // NOTE: unpin() intentionally posts no UNPINNED_MESSAGE line (history is
    // preserved via the soft-deleted pin row, not a chat system message).
    expect(postReturnId).not.toHaveBeenCalled();
  });

  it("CommunityMessageService.pinMessage (gRPC path) emits PINNED_MESSAGE", async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const svc = new CommunityMessageService(
      {
        findById: jest.fn().mockResolvedValue({
          id: MSG_ID,
          roomId: ROOM_ID,
          messageType: "TEXT",
          deletedForAll: false,
        }),
      } as never,
      {
        findRoomById: jest.fn().mockResolvedValue({
          id: ROOM_ID,
          status: "active",
          listPinedMessage: [],
        }),
        updatePinnedMessages: jest.fn().mockResolvedValue(undefined),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      {} as never,
      {} as never,
      { post } as never
    );

    await svc.pinMessage({
      messageId: MSG_ID,
      userId: USER_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
    });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessageType: "PINNED_MESSAGE" })
    );
  });
});
