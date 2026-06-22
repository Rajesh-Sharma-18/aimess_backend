/**
 * Suite: community chat summaries — PERSONAL line overlay.
 *
 * `CommunityMessageService.getChatSummaries` feeds GET /communities/mine
 * (community-service gRPC). It must surface the CALLER's own latest PERSONAL
 * line ("You joined the community") as `personalLastMessage` so community-service
 * can show the joiner that line while everyone else keeps the community-wide
 * message. A personal line is NEVER another user's — it is scoped by
 * `visibleToUserId === userId` at the repository layer.
 *
 * Direct service unit test (getChatSummaries is gRPC-only — no REST route), with
 * the four touched repository methods hand-mocked.
 */
import { CommunityMessageService } from "../../src/services/community-message.service.js";

const USER = "user-a";
const COMM_JOINED = "c-joined";
const COMM_OTHER = "c-other";

function buildService(overrides: {
  members: Array<{ roomId: string; lastReadAt: Date | null }>;
  rooms: Array<{ id: string; lastMessage: unknown }>;
  personal: Map<string, { message: string; createdAt: Date }>;
}) {
  const memberRepo = {
    findActiveByUserAndRooms: jest.fn().mockResolvedValue(
      overrides.members.map((m) => ({
        roomId: m.roomId,
        lastReadAt: m.lastReadAt,
      }))
    ),
  };
  const roomRepo = {
    findManyByIds: jest.fn().mockResolvedValue(overrides.rooms),
  };
  const messageRepo = {
    countUnreadBulk: jest.fn().mockResolvedValue({}),
    findLatestPersonalByRooms: jest.fn().mockResolvedValue(overrides.personal),
  };

  const service = new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    {} as never,
    {} as never
  );
  return { service, messageRepo };
}

describe("getChatSummaries — personalLastMessage overlay", () => {
  it("attaches the caller's own join line as personalLastMessage (joiner)", async () => {
    const joinAt = new Date(1_700_000_300_000);
    const { service, messageRepo } = buildService({
      members: [
        { roomId: COMM_JOINED, lastReadAt: null },
        { roomId: COMM_OTHER, lastReadAt: null },
      ],
      rooms: [
        {
          id: COMM_JOINED,
          lastMessage: {
            content: "Community photo updated",
            messageType: "SYSTEM",
            createdAt: new Date(1_700_000_000_000),
          },
        },
        { id: COMM_OTHER, lastMessage: null },
      ],
      personal: new Map([
        [
          COMM_JOINED,
          { message: "You joined the community", createdAt: joinAt },
        ],
      ]),
    });

    const summaries = await service.getChatSummaries({
      userId: USER,
      communityIds: [COMM_JOINED, COMM_OTHER],
    });

    // The repo lookup is scoped to the requesting user.
    expect(messageRepo.findLatestPersonalByRooms).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER })
    );

    const joined = summaries.find((s) => s.communityId === COMM_JOINED)!;
    expect(joined.personalLastMessage).toEqual({
      message: "You joined the community",
      dateTime: joinAt.getTime(),
    });
    // The community-wide preview is preserved alongside the personal overlay.
    expect(joined.lastMessage?.message).toBe("Community photo updated");

    // A room with no personal line carries no personalLastMessage.
    const other = summaries.find((s) => s.communityId === COMM_OTHER)!;
    expect(other.personalLastMessage).toBeUndefined();
  });

  it("omits personalLastMessage entirely for a member with no personal line (other members)", async () => {
    const { service } = buildService({
      members: [{ roomId: COMM_JOINED, lastReadAt: null }],
      rooms: [
        {
          id: COMM_JOINED,
          lastMessage: {
            content: "Community photo updated",
            messageType: "SYSTEM",
            createdAt: new Date(1_700_000_000_000),
          },
        },
      ],
      personal: new Map(), // admin/mod/other member: no personal line for them
    });

    const summaries = await service.getChatSummaries({
      userId: "admin-x",
      communityIds: [COMM_JOINED],
    });

    expect(summaries[0]!.personalLastMessage).toBeUndefined();
    expect(summaries[0]!.lastMessage?.message).toBe("Community photo updated");
  });
});
