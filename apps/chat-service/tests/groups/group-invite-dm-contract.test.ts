/**
 * The GROUP invitation DM written by `POST /api/chat/invite-links/room/:roomId/
 * bulk-send` must be shaped exactly like the community invitation DM (and, one
 * level up, like the VOICE_CALL reference row): a dedicated `contentType`, the
 * card under `content.invitation`, event-level metadata only in `systemData`.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const TOKEN = "tok-1234567890";
const RECIPIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE_ROOM = "prv_room_1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());

  mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
    async (_roomId: string, userId: string) =>
      userId === TEST_USER_ID ? { role: "ADMIN" } : null
  );
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
    roomId: ROOM,
    name: "Weekend Squad",
    avatar: "",
    memberCount: 8,
  });
  mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
    token: TOKEN,
    roomId: ROOM,
  });
  mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
    roomId: PRIVATE_ROOM,
    participants: [TEST_USER_ID, RECIPIENT],
  });
  mocks.privateRoomRepo.allocateSequence.mockResolvedValue(4);
  mocks.privateRoomRepo.updateRoomOnNewMessage.mockResolvedValue(null);
  mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.privateMessageRepo.createMessage.mockResolvedValue({
    id: "msg_g1",
    createdAt: new Date(1000),
    sequenceNumber: 4,
    revision: 1,
  });
});

const bulkSend = () =>
  request(app)
    .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
    .set(bearer(makeAccessToken()))
    .send({ userIds: [RECIPIENT], token: TOKEN });

describe("group invite DM — message contract", () => {
  it("stores a GROUP_INVITE row with content.invitation and event-only systemData", async () => {
    const res = await bulkSend();
    expect(res.status).toBe(200);

    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledTimes(1);
    const arg = mocks.privateMessageRepo.createMessage.mock.calls[0][0];

    expect(arg.messageType).toBe("GROUP_INVITE");
    expect(arg.systemEvent).toBe("GROUP_INVITE");
    expect(arg.content.text).toBe("Invitation to join Weekend Squad");
    expect(arg.content.urls).toEqual([]);
    expect(arg.content.files).toEqual([]);
    expect(arg.content.invitation).toEqual({
      type: "GROUP_INVITATION",
      groupId: ROOM,
      groupName: "Weekend Squad",
      groupAvatarUrl: "",
      memberCount: 8,
      inviteToken: TOKEN,
      deepLink: `aimess://join-group?token=${TOKEN}`,
      alreadyJoined: false,
      status: "ACTIVE",
      requiresApproval: false,
      canOpen: true,
    });
    // Nothing presentational is duplicated out of content.invitation.
    expect(arg.systemData).toEqual({
      invitationType: "GROUP",
      groupId: ROOM,
      token: TOKEN,
      inviteUrl: expect.stringContaining(TOKEN),
      inviterId: TEST_USER_ID,
      inviterName: expect.any(String),
      actorId: TEST_USER_ID,
      actorName: expect.any(String),
    });
  });

  it("broadcasts message:new with the invitation kind and the legacy systemAction mirror", async () => {
    await bulkSend();

    const publish = mocks.redis.publish.mock.calls.find(
      (c: unknown[]) => c[0] === `conv:${PRIVATE_ROOM}`
    );
    expect(publish).toBeDefined();
    const envelope = JSON.parse(publish![1] as string);
    expect(envelope.event).toBe("message:new");
    expect(envelope.data.contentType).toBe("GROUP_INVITE");
    expect(envelope.data.content.invitation).toMatchObject({
      type: "GROUP_INVITATION",
      groupId: ROOM,
      inviteToken: TOKEN,
    });
    // Same object, not a second computation.
    expect(envelope.data.systemAction).toEqual(
      envelope.data.content.invitation
    );
  });

  // AIMESS-265: the live card used to omit this, so clients drew "Join Group" until a reload.
  it("marks a private group's live card requiresApproval, stored and broadcast alike", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Greenary",
      avatar: "",
      memberCount: 3,
      settings: { joinApproval: true },
    });
    await bulkSend();

    const arg = mocks.privateMessageRepo.createMessage.mock.calls[0][0];
    expect(arg.content.invitation.requiresApproval).toBe(true);
    const publish = mocks.redis.publish.mock.calls.find(
      (c: unknown[]) => c[0] === `conv:${PRIVATE_ROOM}`
    );
    expect(JSON.parse(publish![1] as string).data.content.invitation.requiresApproval).toBe(true);
  });

  it("still delivers the DM to a recipient who is already a member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });

    const res = await bulkSend();
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { userId: RECIPIENT, status: "SENT" },
    ]);
    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalled();
  });

  it("AIMESS-268: the caller can share the invite to their own self chat", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
      roomId: PRIVATE_ROOM,
      participants: [TEST_USER_ID, TEST_USER_ID],
    });

    const res = await request(app)
      .post(`/api/chat/invite-links/room/${ROOM}/bulk-send`)
      .set(bearer(makeAccessToken()))
      .send({ userIds: [TEST_USER_ID], token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([{ userId: TEST_USER_ID, status: "SENT" }]);
    expect(mocks.privateRoomRepo.findByParticipantsKey).toHaveBeenCalledWith(
      `${TEST_USER_ID}:${TEST_USER_ID}`
    );
    expect(mocks.privateMessageRepo.createMessage.mock.calls[0][0]).toMatchObject({
      senderId: TEST_USER_ID,
      receiverId: TEST_USER_ID,
    });
  });

  it("NEGATIVE: 404 for a token that does not belong to the room", async () => {
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue({
      token: TOKEN,
      roomId: "some_other_room",
    });

    const res = await bulkSend();
    expect(res.status).toBe(404);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });
});
