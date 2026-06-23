/**
 * Suite: community-system-message-delivery
 *
 * Pins two guarantees of CommunitySystemMessageService that the live community
 * LIST + role-change UX depend on:
 *
 *  1. REAL-TIME LIST BUMP (Issues #2/#3/#4/#5). A COMMUNITY-visible system line
 *     that bumps activity ALSO fans out a sender-less `community:updated` socket
 *     bump (via publishCommunityUpdatedSafe) so the live list reorders and shows
 *     the standalone system line — byte-identical to the room — WITHOUT a manual
 *     refetch. The bump fires ONLY when a memberRepo is wired (production) and is
 *     SUPPRESSED for PERSONAL lines (e.g. "You joined the community").
 *
 *  2. DETERMINISTIC ROLE-CHANGE TEXT (Issue #1). One stored row, identical for
 *     every viewer; the 6 role transitions render the exact Telegram phrasing.
 *
 * Pure unit test: every dependency is a hand-rolled mock.
 */

jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishCommunityUpdatedSafe: jest.fn(),
}));

import {
  CommunitySystemMessageType,
  SYSTEM_MESSAGE_VISIBILITY,
  SYSTEM_MESSAGE_BUMPS_ACTIVITY,
} from "@aimess/constants";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { publishCommunityUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { publishCommunityActivitySafe } from "../../src/events/publish-community-activity.js";

const pubListBump = publishCommunityUpdatedSafe as jest.Mock;
const pubActivity = publishCommunityActivitySafe as jest.Mock;

const EVENT_AT = "2026-06-19T12:00:00.000Z";
const COMMUNITY_ID = "comm-1";
const ACTOR = "actor-1";
const TARGET = "target-1";

function makeService(
  opts: {
    withMemberRepo?: boolean;
    snapshots?: Array<[string, Record<string, unknown>]>;
    memberIds?: string[];
    /** Non-null → the dedup pre-check finds an existing row (redelivery/replay). */
    findOneResult?: unknown;
  } = {}
) {
  // createSystemMessage echoes the fallbackText it received so assertions can
  // read the deterministic stored text straight off the create call.
  const createSystemMessage = jest.fn(
    async (params: { fallbackText: string }) => ({
      id: "msg-1",
      sentBy: ACTOR,
      senderName: "Admin",
      message: params.fallbackText,
      messageType: "SYSTEM",
      createdAt: new Date(EVENT_AT),
    })
  );
  const findOne = jest.fn(async () => opts.findOneResult ?? null);
  const messageRepo = { findOne, createSystemMessage };

  const roomRepo = {
    allocateSequence: jest.fn(async () => 7),
    addLastestMessageToRoom: jest.fn(async () => undefined),
  };

  const cacheRepo = {};
  const userSnapshotService = {
    getUserSnapshotsMap: jest.fn(
      async () =>
        new Map<string, Record<string, unknown>>(
          opts.snapshots ?? [[ACTOR, { displayName: "Admin" }]]
        )
    ),
  };

  const redis = { publish: jest.fn(async () => 1) };

  const memberIds = opts.memberIds ?? ["u1", "u2"];
  const memberRepo = {
    findActiveByRoom: jest.fn(async () =>
      memberIds.map((userId) => ({ userId }))
    ),
  };

  const service = new CommunitySystemMessageService(
    messageRepo as never,
    roomRepo as never,
    cacheRepo as never,
    userSnapshotService as never,
    redis as never,
    opts.withMemberRepo ? (memberRepo as never) : undefined
  );

  return { service, createSystemMessage, memberRepo, redis };
}

beforeEach(() => {
  pubListBump.mockClear();
  pubActivity.mockClear();
});

describe("CommunitySystemMessageService — lastActivity eligibility", () => {
  it.each(["MEMBER_LEFT", "MEMBER_JOINED", "MEMBER_REMOVED"])(
    "%s is a hidden membership line — never persisted or broadcast (post backstop)",
    async (type) => {
      const h = makeService({
        withMemberRepo: true,
        snapshots: [[TARGET, { displayName: "John Doe" }]],
      });

      await h.service.post({
        communityId: COMMUNITY_ID,
        systemMessageType: type as never,
        metadata: { targetUserId: TARGET },
        triggeredByUserId: TARGET,
        eventAt: EVENT_AT,
      });

      // Hidden lines are dropped at post(): no row, no live broadcast, no bump.
      expect(h.createSystemMessage).not.toHaveBeenCalled();
      expect(h.redis.publish).not.toHaveBeenCalled();
      expect(pubActivity).not.toHaveBeenCalled();
      expect(pubListBump).not.toHaveBeenCalled();
    }
  );

  it("a COMMUNITY content line (ROLE_CHANGED) still bumps lastActivity", async () => {
    const h = makeService({
      withMemberRepo: true,
      snapshots: [
        [ACTOR, { displayName: "Admin" }],
        [TARGET, { displayName: "John Doe" }],
      ],
    });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        targetUserId: TARGET,
        oldRole: "MEMBER",
        newRole: "MODERATOR",
      },
      triggeredByUserId: ACTOR,
      eventAt: EVENT_AT,
    });

    expect(pubActivity).toHaveBeenCalledTimes(1);
    expect(pubListBump).toHaveBeenCalledTimes(1);
  });

  it.each(["MEMBER_MUTED", "MEMBER_UNMUTED"])(
    "%s is delivered but does not bump lastActivity (non-hidden moderation churn)",
    async (type) => {
      const h = makeService({
        withMemberRepo: true,
        snapshots: [[TARGET, { displayName: "John Doe" }]],
      });

      await h.service.post({
        communityId: COMMUNITY_ID,
        systemMessageType: type as never,
        metadata: { targetUserId: TARGET },
        triggeredByUserId: ACTOR,
        eventAt: EVENT_AT,
      });

      // Not hidden → still persisted/delivered, but not eligible to bump.
      expect(h.createSystemMessage).toHaveBeenCalledTimes(1);
      expect(pubActivity).not.toHaveBeenCalled();
      expect(pubListBump).not.toHaveBeenCalled();
    }
  );

  it("Case 3: an eligible line AFTER an ineligible one becomes the new preview", async () => {
    const h = makeService({
      withMemberRepo: true,
      snapshots: [
        [ACTOR, { displayName: "Admin" }],
        [TARGET, { displayName: "John Doe" }],
      ],
    });

    // Ban (ineligible) → no bump.
    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "MEMBER_BANNED",
      metadata: { targetUserId: TARGET },
      triggeredByUserId: ACTOR,
      eventAt: EVENT_AT,
    });
    expect(pubActivity).not.toHaveBeenCalled();

    // Community name updated (eligible) → bumps and becomes the preview.
    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "COMMUNITY_NAME_UPDATED",
      metadata: {},
      triggeredByUserId: ACTOR,
      eventAt: "2026-06-19T12:01:00.000Z",
    });
    expect(pubActivity).toHaveBeenCalledTimes(1);
  });
});

describe("CommunitySystemMessageService — real-time list bump", () => {
  it("fires a sender-less community:updated for a COMMUNITY line when memberRepo is wired", async () => {
    const h = makeService({
      withMemberRepo: true,
      snapshots: [
        [ACTOR, { displayName: "Admin" }],
        [TARGET, { displayName: "John Doe" }],
      ],
      memberIds: ["u1", "u2", "u3"],
    });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        targetUserId: TARGET,
        oldRole: "MEMBER",
        newRole: "MODERATOR",
      },
      triggeredByUserId: ACTOR,
      eventAt: EVENT_AT,
    });

    expect(pubListBump).toHaveBeenCalledTimes(1);
    const arg = pubListBump.mock.calls[0][0] as {
      communityId: string;
      roomId: string;
      senderId: string;
      preview: { contentType: string; text: string };
      fetchMembers: () => Promise<string[]>;
    };
    expect(arg.communityId).toBe(COMMUNITY_ID);
    // roomId === communityId (GeneralRoom id), same value community:message:new uses.
    expect(arg.roomId).toBe(COMMUNITY_ID);
    expect(arg.senderId).toBe(ACTOR);
    // SYSTEM contentType makes publishCommunityUpdated blank the senderName, so the
    // list renders the standalone sentence (no "<actor>: <system text>" prefix).
    expect(arg.preview.contentType).toBe("SYSTEM");
    expect(arg.preview.text).toBe("John Doe is now a moderator");
    // fetchMembers resolves the active member ids from the wired repo.
    await expect(arg.fetchMembers()).resolves.toEqual(["u1", "u2", "u3"]);
    expect(h.memberRepo.findActiveByRoom).toHaveBeenCalledWith(COMMUNITY_ID);
  });

  it("does NOT fire community:updated when no memberRepo is wired (5-arg construction)", async () => {
    const h = makeService({ withMemberRepo: false });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        targetUserId: TARGET,
        oldRole: "MEMBER",
        newRole: "MODERATOR",
      },
      triggeredByUserId: ACTOR,
      eventAt: EVENT_AT,
    });

    expect(pubListBump).not.toHaveBeenCalled();
  });

  it("does NOT fire community:updated for a PERSONAL line (e.g. COMMUNITY_JOINED)", async () => {
    const h = makeService({ withMemberRepo: true });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "COMMUNITY_JOINED",
      metadata: {},
      triggeredByUserId: ACTOR,
      visibleToUserId: ACTOR,
      eventAt: EVENT_AT,
    });

    expect(pubListBump).not.toHaveBeenCalled();
  });

  it("does NOT re-fire community:updated on a REDELIVERY (replay-gated, even with memberRepo)", async () => {
    // Dedup pre-check finds an existing row → the whole post short-circuits before
    // the bump. Guards against a redelivered event triggering a duplicate live-list
    // reorder (the new bump sits after the `if (!message) return` replay guard).
    const h = makeService({
      withMemberRepo: true,
      findOneResult: { id: "already-posted" },
    });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "ROLE_CHANGED",
      metadata: {
        targetUserId: TARGET,
        oldRole: "MEMBER",
        newRole: "MODERATOR",
      },
      triggeredByUserId: ACTOR,
      eventAt: EVENT_AT,
    });

    expect(h.createSystemMessage).not.toHaveBeenCalled();
    expect(pubListBump).not.toHaveBeenCalled();
  });
});

describe("system-message registry — new subtypes are COMMUNITY-visible + bump", () => {
  it("COMMUNITY_DESCRIPTION_UPDATED and COMMUNITY_BANNER_UPDATED route community-wide and bump the list", () => {
    for (const type of [
      "COMMUNITY_DESCRIPTION_UPDATED",
      "COMMUNITY_BANNER_UPDATED",
    ] as const) {
      expect(SYSTEM_MESSAGE_VISIBILITY[type]).toBe("COMMUNITY");
      expect(SYSTEM_MESSAGE_BUMPS_ACTIVITY[type]).toBe(true);
    }
  });

  it("every subtype has a visibility + bump entry (no registry drift)", () => {
    for (const type of Object.values(CommunitySystemMessageType)) {
      expect(SYSTEM_MESSAGE_VISIBILITY[type]).toBeDefined();
      expect(typeof SYSTEM_MESSAGE_BUMPS_ACTIVITY[type]).toBe("boolean");
    }
  });
});

describe("CommunitySystemMessageService — deterministic role-change text", () => {
  const cases: Array<{
    label: string;
    oldRole: string;
    newRole: string;
    expected: string;
  }> = [
    {
      label: "Member → Moderator",
      oldRole: "MEMBER",
      newRole: "MODERATOR",
      expected: "John Doe is now a moderator",
    },
    {
      label: "Member → Admin",
      oldRole: "MEMBER",
      newRole: "ADMIN",
      expected: "John Doe is now an admin",
    },
    {
      label: "Moderator → Admin",
      oldRole: "MODERATOR",
      newRole: "ADMIN",
      expected: "John Doe is now an admin",
    },
    {
      label: "Moderator → Member",
      oldRole: "MODERATOR",
      newRole: "MEMBER",
      expected: "John Doe is now a member",
    },
    {
      label: "Admin → Member",
      oldRole: "ADMIN",
      newRole: "MEMBER",
      expected: "John Doe is now a member",
    },
    {
      label: "Admin → Moderator",
      oldRole: "ADMIN",
      newRole: "MODERATOR",
      expected: "John Doe is now a moderator",
    },
  ];

  for (const c of cases) {
    it(`${c.label} → "${c.expected}"`, async () => {
      const h = makeService({
        withMemberRepo: true,
        snapshots: [
          [ACTOR, { displayName: "Admin" }],
          [TARGET, { displayName: "John Doe" }],
        ],
      });

      await h.service.post({
        communityId: COMMUNITY_ID,
        systemMessageType: "ROLE_CHANGED",
        metadata: {
          targetUserId: TARGET,
          oldRole: c.oldRole,
          newRole: c.newRole,
        },
        triggeredByUserId: ACTOR,
        eventAt: EVENT_AT,
      });

      const arg = h.createSystemMessage.mock.calls[0][0] as {
        fallbackText: string;
      };
      expect(arg.fallbackText).toBe(c.expected);
    });
  }
});
