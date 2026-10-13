/**
 * System Messages v2 §4 — an Admin/Moderator deleting ANOTHER member's
 * community message posts one MESSAGE_DELETED line (COMMUNITY visibility),
 * carrying the actor's live role snapshot. Own-message deletes post nothing.
 */
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

const ROOM_ID = "c".repeat(24);
const MSG_ID = "m".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function mockLiveRole(role: string): void {
  (getCommunityReconcileClient as jest.Mock).mockReturnValue({
    checkCommunityMembership: jest.fn(async ({ userId }: { userId: string }) => ({
      isMember: true,
      isBanned: false,
      status: "ACTIVE",
      role: userId === USER_ID ? role : "MEMBER",
    })),
  });
}

function buildService(sentBy: string) {
  const message = {
    id: MSG_ID,
    roomId: ROOM_ID,
    sentBy,
    senderName: "Binh",
    messageType: "TEXT",
    deletedFor: [],
  };
  const systemMessageService = { post: jest.fn().mockResolvedValue(undefined) };
  const service = new CommunityMessageService(
    {
      findById: jest.fn().mockResolvedValue(message),
      deleteForAll: jest.fn().mockResolvedValue(message),
      refreshReplyQuotes: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      findRoomById: jest.fn().mockResolvedValue({ id: ROOM_ID, status: "active" }),
      allocateRevision: jest.fn().mockResolvedValue(1),
    } as never,
    {
      findByRoomAndUser: jest.fn().mockResolvedValue({
        roomId: ROOM_ID,
        userId: USER_ID,
        status: "active",
        role: "member",
        isMuted: false,
        mutedUntil: null,
      }),
    } as never,
    {} as never,
    {} as never,
    systemMessageService as never
  );
  return { service, systemMessageService };
}

describe("CommunityMessageService.deleteForAll — MESSAGE_DELETED line", () => {
  it.each([
    ["MODERATOR", "MODERATOR"],
    ["ADMIN", "ADMIN"],
    ["OWNER", "ADMIN"],
  ])("%s deleting another's message posts the line (actorRole %s)", async (live, snap) => {
    mockLiveRole(live);
    const { service, systemMessageService } = buildService(OTHER_ID);

    await service.deleteForAll(MSG_ID, USER_ID);

    expect(systemMessageService.post).toHaveBeenCalledWith({
      communityId: ROOM_ID,
      systemMessageType: "MESSAGE_DELETED",
      metadata: {
        actorId: USER_ID,
        actorRole: snap,
        senderId: OTHER_ID,
        senderName: "Binh",
        messageId: MSG_ID,
      },
      triggeredByUserId: USER_ID,
    });
  });

  it("own-message delete posts no line", async () => {
    mockLiveRole("ADMIN");
    const { service, systemMessageService } = buildService(USER_ID);

    await service.deleteForAll(MSG_ID, USER_ID);

    expect(systemMessageService.post).not.toHaveBeenCalled();
  });
});
