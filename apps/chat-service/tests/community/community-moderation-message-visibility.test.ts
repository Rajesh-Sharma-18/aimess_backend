/**
 * Suite: community-moderation-message-visibility
 *
 * REQUIREMENT — in community chat, the moderation audit system lines
 * (MEMBER_ADDED, MEMBER_BANNED, MEMBER_UNBANNED, MEMBER_MUTED, MEMBER_UNMUTED)
 * are readable by the community's OWNER / ADMIN / MODERATOR only. A plain member
 * must not be able to obtain them from ANY backend surface — history, either
 * pagination axis, around-message, catch-up/sync, the list preview, unread,
 * search — nor receive them over a socket. Frontend hiding is not the boundary;
 * these tests only ever exercise backend code.
 *
 * Authorization is STRUCTURAL: it keys off `systemMessageType` +
 * `visibleToUserId` + the viewer's CURRENT role, never off the rendered
 * sentence, so it holds for every locale and for rows persisted before the
 * policy existed. The last case of block 1 pins that explicitly.
 *
 * NOT restricted, and asserted here so the gate can never widen by accident:
 * every other community system subtype (created / renamed / privacy changed /
 * role changed / pinned / livestream / join-request lines), and the PERSONAL
 * target-addressed copy of MEMBER_ADDED and MEMBER_MUTED — the member's own
 * "{admin} added you" / "You are muted until …" notice, which is theirs, not a
 * moderation record about somebody else.
 */
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishCommunityUpdatedSafe: jest.fn(),
}));

import {
  MODERATION_ONLY_SYSTEM_MESSAGE_TYPES,
  MODERATION_VIEWER_ROLES,
  SYSTEM_MESSAGE_BUMPS_ACTIVITY,
  canViewSystemMessage,
  hasPersonalModerationCopy,
  isModerationOnlySystemMessage,
  isModerationViewerRole,
} from "@aimess/constants";
import {
  GeneralRoomMessageRepository,
  isVisibleToUser,
} from "../../src/repositories/general-room-message.repository.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import {
  makeTimelinePrisma,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ROOM = "c".repeat(24);
const VIEWER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

/** The five restricted subtypes — the requirement's visibility-matrix rows. */
const RESTRICTED = [...MODERATION_ONLY_SYSTEM_MESSAGE_TYPES];

/** The matrix columns. */
const PRIVILEGED = ["owner", "admin", "moderator"];
const UNPRIVILEGED = ["member", null];

/**
 * Only MEMBER_ADDED and MEMBER_MUTED post a PERSONAL companion copy to the
 * affected member on top of the audit line. Ban, unban and unmute post the audit
 * line ONLY — the affected member learns about those out-of-band (banner + push;
 * composer re-enable + mute-line retraction), so a target-addressed row of one of
 * those three can only be a legacy artifact and is withheld from everyone.
 */
const RESTRICTED_WITH_COMPANION = RESTRICTED.filter((t) =>
  hasPersonalModerationCopy(t)
);
const RESTRICTED_WITHOUT_COMPANION = RESTRICTED.filter(
  (t) => !hasPersonalModerationCopy(t)
);

// ---------------------------------------------------------------------------
// 1. The central policy — the ONE function every surface routes through.
// ---------------------------------------------------------------------------
describe("canViewSystemMessage — role/event visibility matrix", () => {
  it.each(RESTRICTED)(
    "%s (community-scoped) is NEVER readable by a plain member",
    (type) => {
      const message = { systemMessageType: type, visibleToUserId: null };
      for (const viewerRole of UNPRIVILEGED) {
        expect(
          canViewSystemMessage({ message, viewerId: VIEWER, viewerRole })
        ).toBe(false);
      }
      // A read path that forgets to pass the role must under-report for a
      // moderator, never leak to a member: the default is FAIL-CLOSED.
      expect(canViewSystemMessage({ message, viewerId: VIEWER })).toBe(false);
    }
  );

  it.each(RESTRICTED)(
    "%s (community-scoped) IS readable by owner/admin/moderator",
    (type) => {
      const message = { systemMessageType: type, visibleToUserId: null };
      for (const viewerRole of PRIVILEGED) {
        expect(
          canViewSystemMessage({ message, viewerId: VIEWER, viewerRole })
        ).toBe(true);
      }
    }
  );

  it.each(RESTRICTED_WITHOUT_COMPANION)(
    "a legacy target-addressed %s row is withheld even from its own target",
    (type) => {
      // Ban / unban / unmute post no bubble to the affected member any more. A row
      // persisted before that (visibleToUserId set) must not resurrect one — the
      // moderator-readable record is the separate community-scoped row above.
      for (const viewerRole of [...PRIVILEGED, ...UNPRIVILEGED]) {
        expect(
          canViewSystemMessage({
            message: { systemMessageType: type, visibleToUserId: TARGET },
            viewerId: TARGET,
            viewerRole,
          })
        ).toBe(false);
      }
    }
  );

  it("names exactly the two subtypes that keep a companion copy", () => {
    // Guards the split itself: widening it would hand a member a bubble the
    // product removed, narrowing it would strip a member's own mute/add notice.
    expect([...RESTRICTED_WITH_COMPANION]).toEqual([
      "MEMBER_ADDED",
      "MEMBER_MUTED",
    ]);
    expect([...RESTRICTED_WITHOUT_COMPANION]).toEqual([
      "MEMBER_BANNED",
      "MEMBER_UNBANNED",
      "MEMBER_UNMUTED",
    ]);
  });

  it("platform super-admin / backoffice monitoring keeps full visibility", () => {
    // A super admin is not a community member and has NO community role, so it
    // must not fall through the role gate as if it were a plain member.
    for (const type of RESTRICTED) {
      expect(
        canViewSystemMessage({
          message: { systemMessageType: type, visibleToUserId: null },
          viewerId: "",
          viewerRole: null,
          viewerIsPlatformAdmin: true,
        })
      ).toBe(true);
    }
  });

  it("keeps the PERSONAL target-addressed copy for its own recipient", () => {
    // "{admin} added you to the community" / "You are muted until …" belong to
    // the affected member (an ordinary member), not to the moderation audit.
    for (const type of ["MEMBER_ADDED", "MEMBER_MUTED"]) {
      const message = { systemMessageType: type, visibleToUserId: TARGET };
      expect(
        canViewSystemMessage({
          message,
          viewerId: TARGET,
          viewerRole: "member",
        })
      ).toBe(true);
      // …and still nobody else's, moderator or not.
      for (const viewerRole of ["member", "moderator"]) {
        expect(
          canViewSystemMessage({ message, viewerId: VIEWER, viewerRole })
        ).toBe(false);
      }
    }
  });

  it("leaves every OTHER community system subtype's visibility untouched", () => {
    const unrelated = [
      "COMMUNITY_CREATED",
      "COMMUNITY_NAME_UPDATED",
      "COMMUNITY_AVATAR_UPDATED",
      "COMMUNITY_PRIVACY_CHANGED",
      "COMMUNITY_UPDATED",
      "ROLE_CHANGED",
      "PINNED_MESSAGE",
      "UNPINNED_MESSAGE",
      "LIVE_STREAM_STARTED",
      "LIVE_STREAM_ENDED",
      "COMMUNITY_INVITE_CREATED",
    ];
    for (const type of unrelated) {
      expect(isModerationOnlySystemMessage(type)).toBe(false);
      expect(
        canViewSystemMessage({
          message: { systemMessageType: type, visibleToUserId: null },
          viewerId: VIEWER,
          viewerRole: "member",
        })
      ).toBe(true);
    }
    // Personal join-onboarding lines still reach their own recipient.
    for (const type of ["COMMUNITY_JOINED", "JOIN_REQUEST_REJECTED"]) {
      expect(
        canViewSystemMessage({
          message: { systemMessageType: type, visibleToUserId: VIEWER },
          viewerId: VIEWER,
          viewerRole: "member",
        })
      ).toBe(true);
    }
    // And an ordinary (non-system) message is never affected.
    expect(
      canViewSystemMessage({ message: {}, viewerId: VIEWER, viewerRole: null })
    ).toBe(true);
  });

  it("hidden subtypes stay hidden from EVERYONE, moderators included", () => {
    for (const type of ["MEMBER_LEFT", "MEMBER_JOINED", "MEMBER_REMOVED"]) {
      for (const viewerRole of [...PRIVILEGED, "member"]) {
        expect(
          canViewSystemMessage({
            message: { systemMessageType: type, visibleToUserId: null },
            viewerId: VIEWER,
            viewerRole,
          })
        ).toBe(false);
      }
    }
  });

  it("resolves visibility from the viewer's CURRENT role (promote/demote)", () => {
    const message = {
      systemMessageType: "MEMBER_UNBANNED",
      visibleToUserId: null,
    };
    // Historical rows already exist. Promotion grants access immediately …
    expect(
      canViewSystemMessage({ message, viewerId: VIEWER, viewerRole: "member" })
    ).toBe(false);
    expect(
      canViewSystemMessage({
        message,
        viewerId: VIEWER,
        viewerRole: "moderator",
      })
    ).toBe(true);
    // … and demotion revokes it just as immediately, regardless of whether the
    // row was originally delivered to that session over a socket.
    expect(
      canViewSystemMessage({ message, viewerId: VIEWER, viewerRole: "member" })
    ).toBe(false);
  });

  it("accepts both the chat (lower-case) and community (UPPER) role spellings", () => {
    for (const role of MODERATION_VIEWER_ROLES) {
      expect(isModerationViewerRole(role)).toBe(true);
      expect(isModerationViewerRole(role.toUpperCase())).toBe(true);
    }
    for (const role of ["member", "MEMBER", "", null, undefined, "guest"]) {
      expect(isModerationViewerRole(role)).toBe(false);
    }
  });

  it("authorizes on structured type, never on the rendered sentence", () => {
    // An ordinary message whose TEXT reads like a ban stays visible …
    expect(
      isVisibleToUser(
        { systemMessageType: null, visibleToUserId: null },
        VIEWER,
        true,
        "member"
      )
    ).toBe(true);
    // … while a restricted row carrying NO text at all is still withheld. So a
    // VI/TH localized line is gated identically to the EN one, and a legacy row
    // needs no text parsing (or migration) to be protected.
    expect(
      isVisibleToUser(
        { systemMessageType: "MEMBER_BANNED", visibleToUserId: null },
        VIEWER,
        true,
        "member"
      )
    ).toBe(false);
    expect(
      isVisibleToUser(
        { systemMessageType: "MEMBER_UNBANNED", visibleToUserId: null },
        VIEWER,
        true,
        "moderator"
      )
    ).toBe(true);
  });

  it("keeps every restricted subtype out of the lastActivity preview registry", () => {
    // The community-list preview must never be a moderation line for ANYONE, so
    // the bump registry and this gate have to agree.
    for (const type of RESTRICTED) {
      expect(SYSTEM_MESSAGE_BUMPS_ACTIVITY[type]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The real repository read paths, over an in-memory Mongo emulator so the
//    production `$match` (not a re-implementation of it) is what gets asserted.
// ---------------------------------------------------------------------------
const BASE_MS = 1_700_000_000_000;

/** Rows oldest→newest in declaration order; ids are 24-hex so `_id` keysets sort. */
function docs(
  rows: Array<{
    n: number;
    systemMessageType?: string | null;
    visibleToUserId?: string | null;
  }>
): EmuDoc[] {
  return rows.map((r) => ({
    _id: String(r.n).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(BASE_MS + r.n * 1000),
    updatedAt: new Date(BASE_MS + r.n * 1000),
    sequenceNumber: r.n,
    revision: r.n,
    deletedForAll: false,
    deletedBy: [] as string[],
    systemMessageType: r.systemMessageType ?? null,
    visibleToUserId: r.visibleToUserId ?? null,
    message: "text",
  }));
}

/** 4 plain messages interleaved with the 5 restricted broadcast lines. */
const MIXED = docs([
  { n: 1 },
  { n: 2, systemMessageType: "MEMBER_ADDED" },
  { n: 3 },
  { n: 4, systemMessageType: "MEMBER_BANNED" },
  { n: 5, systemMessageType: "MEMBER_UNBANNED" },
  { n: 6 },
  { n: 7, systemMessageType: "MEMBER_MUTED" },
  { n: 8, systemMessageType: "MEMBER_UNMUTED" },
  { n: 9 },
  { n: 10, systemMessageType: "ROLE_CHANGED" },
]);

/** All five moderation audit lines are withheld from a plain member and readable
 *  by a moderator, so the moderator additionally sees rows 2, 4, 5, 7 and 8. */
const MEMBER_VISIBLE = ["1", "3", "6", "9", "10"];
const MODERATOR_VISIBLE = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => String(Number(r.id)));
}

function repoOver(rows: EmuDoc[]) {
  const prisma = makeTimelinePrisma("generalRoomMessage", rows) as {
    generalRoomMessage: Record<string, unknown>;
  };
  // findPreviousVisible* re-fetch their single hit with findUnique.
  prisma.generalRoomMessage.findUnique = jest.fn(
    async ({ where }: { where: { id: string } }) => {
      const hit = rows.find((r) => r._id === where.id);
      return hit ? { ...hit, id: hit._id } : null;
    }
  );
  return new GeneralRoomMessageRepository(prisma as never);
}

describe("community history + pagination withhold moderation lines", () => {
  it("history page (timestamp axis) matches the viewer's role", async () => {
    const asMember = await repoOver(MIXED).findByRoomIdTimeline({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      ts: new Date(BASE_MS + 999_000),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: "member",
    });
    expect(ids(asMember.messages).sort()).toEqual([...MEMBER_VISIBLE].sort());

    const asModerator = await repoOver(MIXED).findByRoomIdTimeline({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      ts: new Date(BASE_MS + 999_000),
      inclusive: true,
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: "moderator",
    });
    expect(ids(asModerator.messages).sort()).toEqual(
      [...MODERATOR_VISIBLE].sort()
    );
  });

  it("history page (sequence axis) matches the viewer's role", async () => {
    const asMember = await repoOver(MIXED).findByRoomIdSeq({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      seq: null,
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: "member",
    });
    expect(ids(asMember.messages).sort()).toEqual([...MEMBER_VISIBLE].sort());

    const asModerator = await repoOver(MIXED).findByRoomIdSeq({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      seq: null,
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: "moderator",
    });
    expect(ids(asModerator.messages).sort()).toEqual(
      [...MODERATOR_VISIBLE].sort()
    );
  });

  it("returns FULL pages and an honest hasMore — filtering never shortens a page", async () => {
    // The whole point of gating inside the DB `$match` rather than dropping rows
    // after the `$limit`: a member asking for 3 gets 3 VISIBLE rows, not 3 minus
    // however many restricted lines happened to land in that window.
    const repo = repoOver(MIXED);
    const seen: string[] = [];
    let seq: number | null = null;
    for (let page = 0; page < 10; page++) {
      const { messages, hasMore } = await repo.findByRoomIdSeq({
        roomId: ROOM,
        userId: VIEWER,
        direction: "before",
        seq,
        limit: 3,
        viewerIsActiveMember: true,
        viewerRole: "member",
      });
      seen.push(...ids(messages));
      if (!hasMore) {
        expect(messages.length).toBeLessThanOrEqual(3);
        break;
      }
      // Every non-final page is exactly `limit` visible rows.
      expect(messages).toHaveLength(3);
      seq = messages[messages.length - 1]!.sequenceNumber;
    }
    // Every visible row reached exactly once; no restricted row ever appears.
    expect([...seen].sort()).toEqual([...MEMBER_VISIBLE].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("countTimeline agrees with the page the viewer can actually reach", async () => {
    const asMember = await repoOver(MIXED).countTimeline({
      roomId: ROOM,
      userId: VIEWER,
      viewerIsActiveMember: true,
      viewerRole: "member",
    });
    expect(asMember).toBe(MEMBER_VISIBLE.length);

    const asModerator = await repoOver(MIXED).countTimeline({
      roomId: ROOM,
      userId: VIEWER,
      viewerIsActiveMember: true,
      viewerRole: "moderator",
    });
    expect(asModerator).toBe(MODERATOR_VISIBLE.length);
  });

  it("around-message (jump-to) cannot be used to surface a restricted line", async () => {
    // Anchor ON a restricted row: a member gets the surrounding visible window
    // and never the anchor itself, so jump-to-message is not a side door.
    const asMember = await repoOver(MIXED).findAroundSeq({
      roomId: ROOM,
      userId: VIEWER,
      anchorSeq: 5, // MEMBER_UNBANNED
      limit: 6,
      viewerIsActiveMember: true,
      viewerRole: "member",
    });
    expect(ids(asMember)).not.toContain("5");

    const asModerator = await repoOver(MIXED).findAroundSeq({
      roomId: ROOM,
      userId: VIEWER,
      anchorSeq: 5,
      limit: 6,
      viewerIsActiveMember: true,
      viewerRole: "moderator",
    });
    expect(ids(asModerator)).toContain("5");
  });

  it("socket catch-up by message id (since_id resync) is gated too", async () => {
    // A member who was offline while the moderation happened must not receive
    // the line through the reconnect/missed-event path either.
    const asMember = await repoOver(MIXED).findSinceId({
      roomId: ROOM,
      userId: VIEWER,
      sinceId: "",
      limit: 30,
      viewerRole: "member",
    });
    expect(ids(asMember.messages).sort()).toEqual([...MEMBER_VISIBLE].sort());

    const asModerator = await repoOver(MIXED).findSinceId({
      roomId: ROOM,
      userId: VIEWER,
      sinceId: "",
      limit: 30,
      viewerRole: "moderator",
    });
    expect(ids(asModerator.messages).sort()).toEqual(
      [...MODERATOR_VISIBLE].sort()
    );
  });

  it("the list preview (lastActivity) is never a moderation line, for anyone", async () => {
    // Newest row is a restricted line; the preview recompute must skip past it
    // to the newest row a preview may legitimately show — for EVERY viewer,
    // matching SYSTEM_MESSAGE_BUMPS_ACTIVITY=false on all five subtypes.
    const rows = docs([
      { n: 1 },
      { n: 2, systemMessageType: "ROLE_CHANGED" },
      { n: 3, systemMessageType: "MEMBER_UNBANNED" },
    ]);
    const roomWide = await repoOver(rows).findPreviousVisibleMessage(ROOM);
    expect(roomWide?.systemMessageType).toBe("ROLE_CHANGED");

    const perUser = await repoOver(rows).findPreviousVisibleForUser(
      ROOM,
      VIEWER
    );
    expect(perUser?.systemMessageType).toBe("ROLE_CHANGED");
  });

  it("keeps a member's OWN personal add/mute notice on the history path", async () => {
    // Regression guard on the narrow exception: the target-addressed copy is the
    // member's own membership notice and must survive the moderation gate …
    const rows = docs([
      { n: 1 },
      { n: 2, systemMessageType: "MEMBER_ADDED", visibleToUserId: VIEWER },
      { n: 3, systemMessageType: "MEMBER_MUTED", visibleToUserId: VIEWER },
      { n: 4, systemMessageType: "MEMBER_MUTED", visibleToUserId: TARGET },
    ]);
    const { messages } = await repoOver(rows).findByRoomIdSeq({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      seq: null,
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: "member",
    });
    // … while somebody else's personal copy stays invisible.
    expect(ids(messages).sort()).toEqual(["1", "2", "3"]);
  });

  it("unread never counts a system message of any subtype", async () => {
    // Restricted moderation activity must not badge a member (or anyone): the
    // unread predicate excludes EVERY system row, which this pins at the query.
    const prisma = makeTimelinePrisma("generalRoomMessage", MIXED) as {
      generalRoomMessage: { aggregateRaw: jest.Mock };
    };
    const repo = new GeneralRoomMessageRepository(prisma as never);
    await repo.countUnreadAfter({
      roomId: ROOM,
      userId: VIEWER,
      afterDate: new Date(BASE_MS),
    });
    const match = prisma.generalRoomMessage.aggregateRaw.mock.calls
      .at(-1)![0]
      .pipeline.find((s: Record<string, unknown>) => "$match" in s).$match;
    expect(match.systemMessageType).toEqual({ $in: [null] });
    expect(match.visibleToUserId).toBe(null);
  });

  it("in-chat search excludes every system message (no regression)", async () => {
    // SYSTEM rows were already out of search globally; keep it that way so a
    // restricted line can neither be found nor inflate a member's result count.
    const prisma = makeTimelinePrisma("generalRoomMessage", MIXED) as {
      generalRoomMessage: { aggregateRaw: jest.Mock };
    };
    const repo = new GeneralRoomMessageRepository(prisma as never);
    await repo.countSearchResults(ROOM, "text", VIEWER);
    const match = prisma.generalRoomMessage.aggregateRaw.mock.calls
      .at(-1)![0]
      .pipeline.find((s: Record<string, unknown>) => "$match" in s).$match;
    expect(match.systemMessageType).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Incremental-sync paths that filter in memory (updatedAt / revision feeds).
// ---------------------------------------------------------------------------
describe("incremental sync feeds withhold moderation lines", () => {
  function syncRepo(rows: EmuDoc[]) {
    const prisma = {
      generalRoomMessage: {
        aggregateRaw: jest.fn(async () => []),
        findMany: jest.fn(async () => rows.map((r) => ({ ...r, id: r._id }))),
      },
    };
    return new GeneralRoomMessageRepository(prisma as never);
  }

  it.each([
    ["member", MEMBER_VISIBLE],
    ["moderator", MODERATOR_VISIBLE],
  ])("findUpdatedAtSince (since_ts) for a %s", async (role, expected) => {
    const { messages } = await syncRepo(MIXED).findUpdatedAtSince({
      roomId: ROOM,
      userId: VIEWER,
      fromTs: new Date(BASE_MS),
      limit: 30,
      viewerIsActiveMember: true,
      viewerRole: role as string,
    });
    expect(ids(messages).sort()).toEqual([...(expected as string[])].sort());
  });

  it.each([
    ["member", MEMBER_VISIBLE],
    ["moderator", MODERATOR_VISIBLE],
  ])(
    "findByRoomIdRevisionSince (changes feed) for a %s",
    async (role, expected) => {
      const { messages } = await syncRepo(MIXED).findByRoomIdRevisionSince({
        roomId: ROOM,
        userId: VIEWER,
        sinceRevision: 0,
        limit: 30,
        viewerIsActiveMember: true,
        viewerRole: role as string,
      });
      expect(ids(messages).sort()).toEqual([...(expected as string[])].sort());
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Real-time delivery — recipient resolution BEFORE emission, because a socket
//    push cannot be filtered on the read side.
// ---------------------------------------------------------------------------
describe("socket fan-out for a moderation system line", () => {
  function makeService(memberRepo?: { findModeratorUserIds?: jest.Mock }) {
    const redis = { publish: jest.fn(async () => 1) };
    const createSystemMessage = jest.fn(
      async (p: { fallbackText: string }) => ({
        id: "msg-1",
        sentBy: "admin-1",
        senderName: "Admin",
        message: p.fallbackText,
        messageType: "SYSTEM",
        createdAt: new Date("2026-06-19T12:00:00.000Z"),
      })
    );
    const service = new CommunitySystemMessageService(
      {
        findOne: jest.fn(async () => null),
        createSystemMessage,
        deletePersonalJoinMessages: jest.fn(async () => []),
      } as never,
      {
        allocateSequenceAndRevision: jest.fn(async () => ({
          sequenceNumber: 7,
          revision: 1,
        })),
        addLastestMessageToRoom: jest.fn(async () => undefined),
      } as never,
      {} as never,
      {
        getUserSnapshotsMap: jest.fn(
          async () =>
            new Map<string, Record<string, unknown>>([
              ["admin-1", { displayName: "Ann Admin" }],
              [TARGET, { displayName: "Bob Member" }],
            ])
        ),
      } as never,
      redis as never,
      memberRepo as never
    );
    return { service, redis, createSystemMessage };
  }

  const UNBAN = {
    communityId: ROOM,
    systemMessageType: "MEMBER_UNBANNED" as const,
    metadata: { targetUserId: TARGET },
    triggeredByUserId: "admin-1",
    eventAt: "2026-06-19T12:00:00.000Z",
  };

  it("reaches every admin/moderator session and NEVER the room channel", async () => {
    const findModeratorUserIds = jest.fn(async () => ["admin-1", "mod-1"]);
    const { service, redis } = makeService({ findModeratorUserIds });
    await service.post(UNBAN);

    const channels = redis.publish.mock.calls.map((c) => c[0] as string);
    // One `user:<id>` per privileged member — the PERSONAL channel, so all of
    // that admin's devices/sessions receive it, online or on reconnect.
    expect(channels).toEqual(["user:admin-1", "user:mod-1"]);
    // The room-wide channel is what every ordinary member is subscribed to.
    expect(channels).not.toContain(`community:${ROOM}`);
    expect(findModeratorUserIds).toHaveBeenCalledWith(ROOM);
  });

  it("emits nothing at all rather than falling back to the room channel", async () => {
    // FAIL-CLOSED: with no way to resolve the privileged recipients, skipping the
    // live push is correct — the row is persisted, so moderators still get it
    // from history/sync. Broadcasting would be the exact leak being prevented.
    const { service, redis } = makeService({
      findModeratorUserIds: jest.fn(async () => {
        throw new Error("db down");
      }),
    });
    await service.post(UNBAN);
    expect(redis.publish).not.toHaveBeenCalled();

    const noRepo = makeService(undefined);
    await noRepo.service.post(UNBAN);
    expect(noRepo.redis.publish).not.toHaveBeenCalled();
  });

  it("still broadcasts an UNRELATED system line to the whole room", async () => {
    // The gate must not turn into "hide every SYSTEM message".
    const { service, redis } = makeService({
      findModeratorUserIds: jest.fn(async () => ["admin-1"]),
    });
    await service.post({ ...UNBAN, systemMessageType: "ROLE_CHANGED" });
    expect(redis.publish.mock.calls.map((c) => c[0])).toEqual([
      `community:${ROOM}`,
    ]);
  });

  it("keeps a PERSONAL mute notice on the target's own channel", async () => {
    const { service, redis } = makeService({
      findModeratorUserIds: jest.fn(async () => ["admin-1"]),
    });
    await service.post({
      ...UNBAN,
      systemMessageType: "MEMBER_MUTED",
      visibleToUserId: TARGET,
    });
    expect(redis.publish.mock.calls.map((c) => c[0])).toEqual([
      `user:${TARGET}`,
    ]);
  });
  it("writes the two MEMBER_ADDED copies to different recipients from one subtype", async () => {
    const { service, redis, createSystemMessage } = makeService({
      findModeratorUserIds: jest.fn(async () => ["admin-1", "mod-1"]),
    });
    const base = {
      communityId: ROOM,
      systemMessageType: "MEMBER_ADDED" as const,
      metadata: { targetUserId: TARGET },
      triggeredByUserId: "admin-1",
      eventAt: "2026-06-19T12:00:00.000Z",
    };

    // 1. the added member's own notice …
    await service.post({ ...base, visibleToUserId: TARGET });
    // 2. … and the moderator-only audit line, same subtype, no recipient.
    await service.post(base);

    const persisted = createSystemMessage.mock.calls.map(
      (c: unknown[]) =>
        c[0] as { visibleToUserId: string | null; fallbackText: string }
    );
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.visibleToUserId).toBe(TARGET);
    expect(persisted[1]!.visibleToUserId).toBe(null);

    // Second person for the member; third person, naming both sides, for the
    // audit record — which is the whole content of an audit line. Derived from
    // the structured subtype + metadata, so each session still renders it in its
    // own language; the stored text is only the English fallback.
    expect(persisted[0]!.fallbackText).toBe(
      "Ann Admin added You to the community"
    );
    expect(persisted[1]!.fallbackText).toBe(
      "Ann Admin added Bob Member to the community"
    );

    // Channels match: the member's own copy to them, the audit copy to each
    // privileged member — and never `community:<id>`.
    expect(redis.publish.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      `user:${TARGET}`,
      "user:admin-1",
      "user:mod-1",
    ]);
  });

  it("posts a MUTE audit line naming actor and target alongside the member's own notice", async () => {
    const { service, createSystemMessage } = makeService({
      findModeratorUserIds: jest.fn(async () => ["mod-1"]),
    });
    const base = {
      communityId: ROOM,
      systemMessageType: "MEMBER_MUTED" as const,
      metadata: { targetUserId: TARGET },
      triggeredByUserId: "admin-1",
      eventAt: "2026-06-19T12:00:00.000Z",
    };
    await service.post({ ...base, visibleToUserId: TARGET });
    await service.post(base);

    const text = createSystemMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { fallbackText: string }).fallbackText
    );
    expect(text[0]).toBe("You are muted");
    expect(text[1]).toBe("Ann Admin muted Bob Member");
  });

  it("an auto-unmute (sweeper, no human actor) stores the actor-less audit line", async () => {
    const { service, createSystemMessage } = makeService({
      findModeratorUserIds: jest.fn(async () => ["mod-1"]),
    });
    await service.post({
      communityId: ROOM,
      systemMessageType: "MEMBER_UNMUTED" as const,
      metadata: { targetUserId: TARGET, source: "auto" },
      triggeredByUserId: "system",
      eventAt: "2026-06-19T12:00:00.000Z",
    });
    await service.post({
      communityId: ROOM,
      systemMessageType: "MEMBER_UNMUTED" as const,
      metadata: { targetUserId: TARGET },
      triggeredByUserId: "admin-1",
      eventAt: "2026-06-19T12:05:00.000Z",
    });

    const rows = createSystemMessage.mock.calls.map(
      (c: unknown[]) =>
        c[0] as { fallbackText: string; systemMetadata?: Record<string, unknown> }
    );
    expect(rows[0]!.fallbackText).toBe("Bob Member was unmuted");
    expect(rows[1]!.fallbackText).toBe("Ann Admin unmuted Bob Member");
  });
});

// ---------------------------------------------------------------------------
// 5. Super Admin / backoffice conversation monitoring must not be caught by the
//    gate: a platform admin is not a community member and has NO community role,
//    so it must be granted the moderation view explicitly rather than falling
//    through as an ordinary member.
// ---------------------------------------------------------------------------
describe("Super Admin conversation monitoring keeps moderation visibility", () => {
  function makeService(memberRole?: string) {
    const findByRoomIdTimeline = jest.fn(async () => ({
      messages: [],
      hasMore: false,
    }));
    const countTimeline = jest.fn(async () => 0);
    const messageRepo = {
      findByRoomIdTimeline,
      countTimeline,
      getRoomRevision: jest.fn(async () => 1),
      findByRoomIdSeq: jest.fn(async () => ({ messages: [], hasMore: false })),
    };
    const service = new CommunityMessageService(
      messageRepo as never,
      {
        findRoomById: jest.fn(async () => ({ communityType: "PRIVATE" })),
      } as never,
      {
        findByRoomAndUser: jest.fn(async () =>
          memberRole ? { status: "active", role: memberRole } : null
        ),
      } as never,
      {} as never,
      { getUserSnapshotsMap: jest.fn(async () => new Map()) } as never
    );
    return { service, findByRoomIdTimeline, countTimeline };
  }

  it("reads a PRIVATE community with a privileged role, membership bypassed", async () => {
    const { service, findByRoomIdTimeline, countTimeline } = makeService();
    await service.getMessagesForModeration({ roomId: ROOM, limit: 20 });

    // Both the page and its count must agree, or `total` would describe a
    // different message set than the admin can page through.
    for (const spy of [findByRoomIdTimeline, countTimeline]) {
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ viewerRole: "admin" })
      );
    }
    expect(
      isModerationViewerRole(
        findByRoomIdTimeline.mock.calls[0]![0].viewerRole as string
      )
    ).toBe(true);
  });

  it("passes an ordinary viewer's real role through unchanged", async () => {
    const { service, findByRoomIdTimeline } = makeService("member");
    await service.getMessagesTimeline({
      roomId: ROOM,
      userId: VIEWER,
      direction: "before",
      ts: new Date(),
      inclusive: true,
      limit: 20,
    });
    expect(findByRoomIdTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ viewerRole: "member" })
    );
  });
});
