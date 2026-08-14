/**
 * The invitation message contract — community + group invitation rows must be
 * shaped like the VOICE_CALL reference row: a dedicated `contentType`, the
 * structured card under `content.<kind>`, and event-level metadata only in
 * `systemData`.
 */
import {
  ALL_CONTENT_TYPES,
  CONTENT_TYPES,
  INVITE_CONTENT_TYPES,
  buildPrivateSystemFallbackText,
  inviteContentType,
  isInviteContentType,
  isPersonalizableSystemContentType,
} from "@aimess/constants";

import {
  buildChatMessageEvent,
  buildCommunityInvitationAction,
  buildGroupInvitationAction,
  buildInvitationContent,
  isCommunityInvitationMessage,
  isGroupInvitationMessage,
  readInvitationContent,
} from "../../src/lib/chat-message.serializer.js";

const INVITER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const communityInvitation = buildCommunityInvitationAction({
  communityId: "c1",
  communityName: "Dr. Jhatka",
  communityHandle: "dr-jhatka",
  communityAvatarUrl: "community/avatars/dev.jpg",
  memberCount: 15,
  inviteCode: "abc123",
  deepLink: "aimess://join?code=abc123",
  alreadyJoined: false,
  status: "ACTIVE",
});

const groupInvitation = buildGroupInvitationAction({
  groupId: "g1",
  groupName: "Weekend Squad",
  groupAvatarUrl: "group/avatars/squad.jpg",
  memberCount: 8,
  inviteToken: "tok123",
  deepLink: "aimess://join-group?token=tok123",
  alreadyJoined: false,
  status: "ACTIVE",
});

describe("invitation content types", () => {
  it("are server-emitted only — a client can never send one", () => {
    for (const kind of INVITE_CONTENT_TYPES) {
      expect(CONTENT_TYPES as readonly string[]).not.toContain(kind);
      expect(ALL_CONTENT_TYPES as readonly string[]).toContain(kind);
    }
  });

  it("map the invited-to room kind to the message kind", () => {
    expect(inviteContentType("COMMUNITY")).toBe("COMMUNITY_INVITE");
    expect(inviteContentType("GROUP")).toBe("GROUP_INVITE");
    expect(isInviteContentType("group_invite")).toBe(true);
    expect(isInviteContentType("SYSTEM")).toBe(false);
    expect(isInviteContentType("VOICE_CALL")).toBe(false);
  });

  it("personalize like a SYSTEM row; call rows deliberately do not", () => {
    expect(isPersonalizableSystemContentType("SYSTEM")).toBe(true);
    expect(isPersonalizableSystemContentType("COMMUNITY_INVITE")).toBe(true);
    expect(isPersonalizableSystemContentType("GROUP_INVITE")).toBe(true);
    expect(isPersonalizableSystemContentType("VOICE_CALL")).toBe(false);
  });
});

describe("buildInvitationContent", () => {
  it("mirrors a call row's content shape, with `invitation` in place of `call`", () => {
    const content = buildInvitationContent(
      "Invitation to join Dr. Jhatka",
      communityInvitation
    );
    expect(content).toEqual({
      text: "Invitation to join Dr. Jhatka",
      urls: [],
      files: [],
      invitation: communityInvitation,
    });
    expect(readInvitationContent(content)).toBe(communityInvitation);
  });

  it("carries the discriminator the client switches on", () => {
    expect(
      readInvitationContent(buildInvitationContent("x", groupInvitation))?.type
    ).toBe("GROUP_INVITATION");
  });

  it("returns undefined for a legacy row that has no structured invitation", () => {
    expect(
      readInvitationContent({ text: "Community invitation" })
    ).toBeUndefined();
    expect(readInvitationContent(null)).toBeUndefined();
  });
});

describe("stored-row predicates", () => {
  it("match the current kind AND the legacy SYSTEM rows (no backfill needed)", () => {
    expect(
      isCommunityInvitationMessage({
        messageType: "COMMUNITY_INVITE",
        systemEvent: "COMMUNITY_INVITE",
      })
    ).toBe(true);
    expect(
      isCommunityInvitationMessage({
        messageType: "SYSTEM",
        systemEvent: "COMMUNITY_INVITE",
      })
    ).toBe(true);
    expect(
      isGroupInvitationMessage({
        messageType: "GROUP_INVITE",
        systemEvent: "GROUP_INVITE",
      })
    ).toBe(true);
    expect(
      isGroupInvitationMessage({
        messageType: "SYSTEM",
        systemEvent: "GROUP_INVITE",
      })
    ).toBe(true);
  });

  it("do not match each other or a plain message", () => {
    expect(
      isGroupInvitationMessage({
        messageType: "COMMUNITY_INVITE",
        systemEvent: "COMMUNITY_INVITE",
      })
    ).toBe(false);
    expect(
      isCommunityInvitationMessage({ messageType: "TEXT", systemEvent: null })
    ).toBe(false);
  });
});

describe("invitation status drives canOpen", () => {
  const cases: Array<[string, boolean, boolean]> = [
    // [status, alreadyJoined, canOpen]
    ["ACTIVE", false, true],
    ["EXPIRED", false, false],
    ["REVOKED", false, false],
    ["REVOKED", true, true],
    ["DELETED", true, false],
  ];
  it.each(cases)(
    "community %s / joined=%s → canOpen=%s",
    (status, alreadyJoined, canOpen) => {
      expect(
        buildCommunityInvitationAction({
          communityId: "c1",
          communityName: "Dr. Jhatka",
          deepLink: "d",
          alreadyJoined,
          status: status as "ACTIVE",
        }).canOpen
      ).toBe(canOpen);
    }
  );
  it.each(cases)(
    "group %s / joined=%s → canOpen=%s",
    (status, alreadyJoined, canOpen) => {
      expect(
        buildGroupInvitationAction({
          groupId: "g1",
          groupName: "Weekend Squad",
          deepLink: "d",
          alreadyJoined,
          status: status as "ACTIVE",
        }).canOpen
      ).toBe(canOpen);
    }
  );
});

describe("buildChatMessageEvent for an invitation row", () => {
  const base = {
    id: "m1",
    roomId: "r1",
    conversationType: "PRIVATE" as const,
    senderId: INVITER,
    receiverId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequenceNumber: 1,
    serverTs: 1_700_000_000_000,
  };

  it("emits the invitation kind, the structured content, and the legacy mirror", () => {
    const event = buildChatMessageEvent({
      ...base,
      messageType: inviteContentType("COMMUNITY"),
      content: buildInvitationContent(
        "Invitation to join Dr. Jhatka",
        communityInvitation
      ),
      systemEvent: "COMMUNITY_INVITE",
      systemData: { invitationType: "COMMUNITY", communityId: "c1" },
      systemAction: communityInvitation,
    });
    expect(event.contentType).toBe("COMMUNITY_INVITE");
    expect(event.contentText).toBe("Invitation to join Dr. Jhatka");
    expect(readInvitationContent(event.content)).toEqual(communityInvitation);
    expect(event.systemAction).toEqual(communityInvitation);
  });

  it("leaves a VOICE_CALL row untouched — no invitation anywhere on it", () => {
    const call = {
      callId: "call_1",
      callType: "AUDIO",
      callStatus: "ENDED",
      outcome: "ENDED",
      durationSec: 134,
      callerId: INVITER,
      calleeId: base.receiverId,
    };
    const event = buildChatMessageEvent({
      ...base,
      senderId: "",
      messageType: "VOICE_CALL",
      content: { text: "Call ended 02:14", urls: [], files: [], call },
      systemEvent: "CALL_ENDED",
      systemData: { callId: "call_1", status: "ENDED", durationSec: 134 },
    });
    expect(event.contentType).toBe("VOICE_CALL");
    expect(event.content).toMatchObject({ call });
    expect(readInvitationContent(event.content)).toBeUndefined();
    expect(event).not.toHaveProperty("systemAction");
  });
});

describe("private system line for a shared invitation", () => {
  const data = { actorId: INVITER, actorName: "John" };

  it("names the community invite instead of falling back to 'updated the chat'", () => {
    expect(
      buildPrivateSystemFallbackText("COMMUNITY_INVITE", data, "someone-else")
    ).toBe("John shared a community invite");
    expect(
      buildPrivateSystemFallbackText("COMMUNITY_INVITE", data, INVITER)
    ).toBe("You shared a community invite");
  });

  it("names the group invite", () => {
    expect(
      buildPrivateSystemFallbackText("GROUP_INVITE", data, "someone-else")
    ).toBe("John shared a group invite");
    expect(buildPrivateSystemFallbackText("GROUP_INVITE", data, INVITER)).toBe(
      "You shared a group invite"
    );
  });

  it("REGRESSION: an invite with no actor in systemData still names the action", () => {
    expect(buildPrivateSystemFallbackText("COMMUNITY_INVITE", {}, "")).toBe(
      "Someone shared a community invite"
    );
  });
});
