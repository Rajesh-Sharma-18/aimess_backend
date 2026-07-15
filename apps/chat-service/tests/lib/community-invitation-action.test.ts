import {
  buildCommunityInvitationAction,
  isCommunityInvitationMessage,
} from "../../src/lib/chat-message.serializer.js";

describe("buildCommunityInvitationAction", () => {
  const base = {
    communityId: "c1",
    communityName: "Mighty Raju",
    inviteCode: "abc123",
    deepLink: "aimess://join?code=abc123",
  };

  it("ACTIVE + not joined → canOpen true (invite still usable)", () => {
    const action = buildCommunityInvitationAction({
      ...base,
      alreadyJoined: false,
      status: "ACTIVE",
    });
    expect(action).toMatchObject({
      type: "COMMUNITY_INVITATION",
      alreadyJoined: false,
      status: "ACTIVE",
      canOpen: true,
    });
  });

  it("already joined, even with a REVOKED code → canOpen true (they're a member)", () => {
    const action = buildCommunityInvitationAction({
      ...base,
      alreadyJoined: true,
      status: "REVOKED",
    });
    expect(action.canOpen).toBe(true);
  });

  it("EXPIRED and not joined → canOpen false", () => {
    const action = buildCommunityInvitationAction({
      ...base,
      alreadyJoined: false,
      status: "EXPIRED",
    });
    expect(action.canOpen).toBe(false);
  });

  it("REVOKED and not joined → canOpen false", () => {
    const action = buildCommunityInvitationAction({
      ...base,
      alreadyJoined: false,
      status: "REVOKED",
    });
    expect(action.canOpen).toBe(false);
  });

  it("DELETED community → canOpen false even if already joined (can't happen, but must never open)", () => {
    const action = buildCommunityInvitationAction({
      ...base,
      alreadyJoined: true,
      status: "DELETED",
    });
    expect(action.canOpen).toBe(false);
  });

  it("defaults communityHandle/inviteCode to null when omitted", () => {
    const action = buildCommunityInvitationAction({
      communityId: "c1",
      communityName: "Mighty Raju",
      deepLink: "aimess://join?code=abc123",
      alreadyJoined: false,
      status: "ACTIVE",
    });
    expect(action.communityHandle).toBeNull();
    expect(action.inviteCode).toBeNull();
  });
});

describe("isCommunityInvitationMessage", () => {
  it("true for a SYSTEM message with systemEvent COMMUNITY_INVITE", () => {
    expect(
      isCommunityInvitationMessage({
        messageType: "SYSTEM",
        systemEvent: "COMMUNITY_INVITE",
      })
    ).toBe(true);
  });

  it("false for a normal TEXT message", () => {
    expect(
      isCommunityInvitationMessage({ messageType: "TEXT", systemEvent: null })
    ).toBe(false);
  });

  it("false for a different SYSTEM subtype", () => {
    expect(
      isCommunityInvitationMessage({
        messageType: "SYSTEM",
        systemEvent: "GROUP_CREATED",
      })
    ).toBe(false);
  });
});
