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
  rooms: Array<{
    id: string;
    lastMessage: unknown;
    lastMessageId?: string;
    lastMessageAt?: Date;
  }>;
  personal: Map<string, { message: string; createdAt: Date }>;
  hiddenMessageIds?: Set<string>;
  previousVisibleByRoom?: Map<
    string,
    {
      id: string;
      messageType: string;
      message: string;
      createdAt: Date;
      sentBy?: string;
      senderName?: string;
    } | null
  >;
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
    filterHiddenByUser: jest
      .fn()
      .mockResolvedValue(overrides.hiddenMessageIds ?? new Set()),
    findPreviousVisibleForUser: jest
      .fn()
      .mockImplementation((roomId: string) =>
        Promise.resolve(overrides.previousVisibleByRoom?.get(roomId) ?? null)
      ),
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

  it("delete-for-me: surfaces the previous-visible message as lastMessage WITH sender identity (not a sender-less overlay)", async () => {
    const sharedAt = new Date(1_700_000_000_000);
    const { service } = buildService({
      members: [{ roomId: COMM_JOINED, lastReadAt: null }],
      rooms: [
        {
          id: COMM_JOINED,
          lastMessageId: "m-last",
          lastMessageAt: sharedAt,
          lastMessage: {
            content: "the message I deleted",
            senderId: "carol",
            senderName: "Carol",
            messageType: "TEXT",
            createdAt: sharedAt,
          },
        },
      ],
      personal: new Map(),
      // The shared last is hidden from this viewer (they delete-for-me'd it)…
      hiddenMessageIds: new Set(["m-last"]),
      // …so their effective last is the previous visible message from Bob.
      previousVisibleByRoom: new Map([
        [
          COMM_JOINED,
          {
            id: "m-prev",
            sentBy: "bob",
            senderName: "Bob",
            messageType: "TEXT",
            message: "earlier message",
            createdAt: new Date(1_699_999_000_000),
          },
        ],
      ]),
    });

    const summaries = await service.getChatSummaries({
      userId: USER,
      communityIds: [COMM_JOINED],
    });

    const s = summaries[0]!;
    expect(s.hasLastMessage).toBe(true);
    // perUserResolved => community-service treats this as authoritative (no +1ms).
    expect(s.perUserResolved).toBe(true);
    // Rendered as a MEMBER message shape (carries sender), NOT sender-less SYSTEM,
    // with the previous message's REAL timestamp (no inflation hack).
    expect(s.lastMessage).toEqual({
      username: "Bob",
      message: "earlier message",
      dateTime: new Date(1_699_999_000_000).getTime(),
      isSystem: false,
      userId: "bob",
    });
    // No join line here → personalLastMessage stays absent (the two are now
    // independent signals, no longer colliding in one overlay slot).
    expect(s.personalLastMessage).toBeUndefined();
  });

  it("delete-for-me with NO remaining visible message → hasLastMessage false", async () => {
    const sharedAt = new Date(1_700_000_000_000);
    const { service } = buildService({
      members: [{ roomId: COMM_JOINED, lastReadAt: null }],
      rooms: [
        {
          id: COMM_JOINED,
          lastMessageId: "m-last",
          lastMessageAt: sharedAt,
          lastMessage: {
            content: "only message",
            senderId: "carol",
            senderName: "Carol",
            messageType: "TEXT",
            createdAt: sharedAt,
          },
        },
      ],
      personal: new Map(),
      hiddenMessageIds: new Set(["m-last"]),
      previousVisibleByRoom: new Map([[COMM_JOINED, null]]), // nothing remains
    });

    const summaries = await service.getChatSummaries({
      userId: USER,
      communityIds: [COMM_JOINED],
    });

    expect(summaries[0]!.hasLastMessage).toBe(false);
    expect(summaries[0]!.lastMessage).toBeUndefined();
    // perUserResolved stays TRUE so community-service CLEARS the stale column
    // preview instead of leaving the deleted message showing.
    expect(summaries[0]!.perUserResolved).toBe(true);
  });

  it("delete-for-everyone: room.lastMessage already reflects M2 (set by recalculateLastMessageAfterDelete); filterHiddenByUser returns empty so the shared snapshot is used directly without findPreviousVisibleForUser", async () => {
    const m2At = new Date(1_699_999_000_000);
    const { service, messageRepo } = buildService({
      members: [{ roomId: COMM_JOINED, lastReadAt: null }],
      rooms: [
        {
          id: COMM_JOINED,
          // After recalculateLastMessageAfterDelete ran, room's lastMessageId
          // and lastMessage JSON are already updated to M2.
          lastMessageId: "m2",
          lastMessageAt: m2At,
          lastMessage: {
            content: "M2 text",
            senderId: "bob",
            senderName: "Bob",
            messageType: "TEXT",
            createdAt: m2At,
          },
        },
      ],
      personal: new Map(),
      // M2 is NOT in any user's hidden set — visible path, no per-user fallback.
      hiddenMessageIds: new Set(),
    });

    const summaries = await service.getChatSummaries({
      userId: USER,
      communityIds: [COMM_JOINED],
    });

    const s = summaries[0]!;
    expect(s.hasLastMessage).toBe(true);
    // Shared snapshot path — perUserResolved is false (no per-viewer override).
    expect(s.perUserResolved).toBeFalsy();
    expect(s.lastMessage).toEqual({
      username: "Bob",
      message: "M2 text",
      dateTime: m2At.getTime(),
      isSystem: false,
      userId: "bob",
    });
    // No per-user fallback needed — never called.
    expect(messageRepo.findPreviousVisibleForUser).not.toHaveBeenCalled();
  });
});
