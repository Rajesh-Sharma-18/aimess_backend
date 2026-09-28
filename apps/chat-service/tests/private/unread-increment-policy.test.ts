import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";

/**
 * `updateRoomOnNewMessage` is the one choke point every private send passes
 * through, and it used to credit the recipient's unread counter with a blind
 * `1` whenever a caller did not state an increment. Both invite-DM delivery
 * paths omit it, so the `$inc` and the `countInUnread` persisted on the message
 * beside it were decided by two different rules — and when they disagreed the
 * counter could not be reconciled back down.
 *
 * So an unstated increment now takes the POLICY answer. These pin that, and that
 * an explicit increment is still honoured verbatim (albums send more than one).
 */
const ROOM = "prv_test";
const ME = "receiver";

function repoCapturingUpdate() {
  const calls: Array<Record<string, unknown>> = [];
  const prisma = {
    $runCommandRaw: jest.fn(async (cmd: Record<string, unknown>) => {
      calls.push(cmd.update as Record<string, unknown>);
      return { value: { roomId: ROOM } };
    }),
  };
  const repo = new PrivateRoomRepository(
    prisma as unknown as ConstructorParameters<typeof PrivateRoomRepository>[0]
  );
  return { repo, calls };
}

const message = (over: Record<string, unknown>) => ({
  _id: "6a578402fe2d51e4524f7ced",
  content: { text: "hi" },
  senderId: "sender",
  messageType: "TEXT",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  sequenceNumber: 5,
  ...over,
});

const incFor = (update: Record<string, unknown>) =>
  (update.$inc as Record<string, number> | undefined)?.[
    `unreadCountByUser.${ME}`
  ];

describe("unread increment follows the countability policy", () => {
  it("credits an ordinary message", async () => {
    const { repo, calls } = repoCapturingUpdate();
    await repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({}),
      receiverId: ME,
    });
    expect(incFor(calls[0]!)).toBe(1);
  });

  it("does NOT credit an audit line that no caller vouched for", async () => {
    const { repo, calls } = repoCapturingUpdate();
    await repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({ messageType: "SYSTEM", systemEvent: "MEMBER_ADDED" }),
      receiverId: ME,
    });
    expect(calls[0]!.$inc).toBeUndefined();
  });

  it("does NOT credit a call lifecycle row", async () => {
    const { repo, calls } = repoCapturingUpdate();
    await repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({ messageType: "VOICE_CALL", systemEvent: "CALL_ENDED" }),
      receiverId: ME,
    });
    expect(calls[0]!.$inc).toBeUndefined();
  });

  it("credits an invite card — addressed content, and what the recount now agrees with", async () => {
    const { repo, calls } = repoCapturingUpdate();
    await repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({
        messageType: "SYSTEM",
        systemEvent: "COMMUNITY_INVITE",
      }),
      receiverId: ME,
    });
    expect(incFor(calls[0]!)).toBe(1);
  });

  it("honours an explicit increment, including 0 and an album's many", async () => {
    const zero = repoCapturingUpdate();
    await zero.repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({}),
      receiverId: ME,
      unreadIncrement: 0,
    });
    expect(zero.calls[0]!.$inc).toBeUndefined();

    const album = repoCapturingUpdate();
    await album.repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({ messageType: "IMAGE" }),
      receiverId: ME,
      unreadIncrement: 4,
    });
    expect(incFor(album.calls[0]!)).toBe(4);
  });

  it("credits nobody when the recipient could not be resolved", async () => {
    const { repo, calls } = repoCapturingUpdate();
    await repo.updateRoomOnNewMessage({
      roomId: ROOM,
      message: message({}),
      receiverId: "",
    });
    expect(calls[0]!.$inc).toBeUndefined();
  });
});
