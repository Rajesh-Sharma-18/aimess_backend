/**
 * A group member may not read the room from before their own membership.
 *
 * The boundary itself is old (`getGroupVisibilityCutoff` = the latest of
 * joinedAt / clearedAt / clearChatAt) and the timeline, search, media list and
 * incremental sync already read through it. These pin the ways AROUND it that
 * did not, all reachable by a normal member who simply knows a messageId:
 *
 *   - `?around=<preJoinId>` answered with a window of the OLDEST messages the
 *     caller MAY see — so tapping a reply to a pre-join message threw the
 *     reader to the start of their history and then said "no longer available".
 *   - the same call took a bare id, so the anchor could belong to another group.
 *   - the reply QUOTE (covered in group-reply-quote-boundary) is a snapshot
 *     persisted on the new message, and a crafted `parentMessageId` copied a
 *     pre-join or foreign-room message straight into it.
 *   - forwarding reads `source.content` and republishes it elsewhere.
 *   - a pin created TODAY for an OLD message handed its text and media to a
 *     member who joined in between, and the pin LIST had no boundary at all.
 *
 * And the distinction all of it exists for: "you were not here for this" is not
 * "this is gone", so the two answers are different codes.
 *
 *   npx jest group-pre-join-history
 */
import { ForbiddenError, GoneError, NotFoundError } from "@aimess/errors";

import { GroupMessageService } from "../../src/services/group-message.service.js";
import { GroupPinService } from "../../src/services/group-pin.service.js";
import {
  isBeforeJoinError,
  isMessageContentError,
  messageContextReasonFor,
  buildUnavailableContext,
  MESSAGE_CONTEXT_REASON,
} from "../../src/lib/message-context.js";
import { getGroupVisibilityCutoff } from "../../src/lib/deletion-cutoff.js";

const ROOM_ID = "grp_room_1";
const OTHER_ROOM_ID = "grp_room_2";
const USER_ID = "usr_new_member";
const MSG_ID = "m".repeat(24);

const JOINED_AT = new Date("2026-01-10T10:00:00.000Z");
const BEFORE_JOIN = new Date("2026-01-10T09:00:00.000Z");
const AFTER_JOIN = new Date("2026-01-10T11:00:00.000Z");

const message = (over: Record<string, unknown> = {}) => ({
  id: MSG_ID,
  roomId: ROOM_ID,
  sequenceNumber: 42,
  createdAt: AFTER_JOIN,
  isDeleted: false,
  deletedForUserIds: [],
  senderId: "usr_old_member",
  senderName: "Old Member",
  messageType: "TEXT",
  content: { text: "secret history" },
  ...over,
});

function buildService(over: { member?: unknown } = {}) {
  const findById = jest.fn().mockResolvedValue(message());
  const findAroundSeq = jest.fn().mockResolvedValue([]);
  const findByRoomIdSeq = jest.fn().mockResolvedValue([]);
  const searchByText = jest.fn().mockResolvedValue([]);
  const messageRepo = {
    findById,
    findAroundSeq,
    findByRoomIdSeq,
    searchByText,
  } as never;

  const roomRepo = {
    findByRoomId: jest
      .fn()
      .mockResolvedValue({ roomId: ROOM_ID, status: "ACTIVE" }),
    getRoomRevision: jest.fn().mockResolvedValue(1),
  } as never;

  const member = over.member ?? {
    status: "ACTIVE",
    role: "MEMBER",
    joinedAt: JOINED_AT,
    clearedAt: null,
    clearChatAt: null,
  };
  const findByRoomAndUser = jest.fn().mockResolvedValue(member);
  const findActiveByRoomAndUser = jest
    .fn()
    .mockResolvedValue(
      (member as { status?: string })?.status === "ACTIVE" ? member : null
    );
  const memberRepo = { findByRoomAndUser, findActiveByRoomAndUser } as never;

  const service = new GroupMessageService(
    messageRepo,
    roomRepo,
    memberRepo,
    {} as never,
    {} as never
  );
  return { service, findById, findAroundSeq, searchByText, findByRoomAndUser };
}

const around = (service: GroupMessageService) =>
  service.getMessagesAround({
    roomId: ROOM_ID,
    userId: USER_ID,
    messageId: MSG_ID,
    limit: 30,
  });

describe("around-message: the membership boundary is enforced before navigation", () => {
  it("refuses a pre-join anchor with its own code and builds no window at all", async () => {
    const { service, findById, findAroundSeq } = buildService();
    findById.mockResolvedValue(message({ createdAt: BEFORE_JOIN }));

    await expect(around(service)).rejects.toMatchObject({
      messageKey: "CHAT_MESSAGE_BEFORE_JOIN",
    });
    // The whole point: nothing was fetched, so there is nothing to scroll to
    // and no content to leak on the way.
    expect(findAroundSeq).not.toHaveBeenCalled();
  });

  it("is a ForbiddenError the context layer recognises, not a generic 403", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ createdAt: BEFORE_JOIN }));

    const err = await around(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(isBeforeJoinError(err)).toBe(true);
  });

  it("refuses an anchor from a different room without saying it exists", async () => {
    const { service, findById, findAroundSeq } = buildService();
    findById.mockResolvedValue(message({ roomId: OTHER_ROOM_ID }));

    await expect(around(service)).rejects.toBeInstanceOf(NotFoundError);
    expect(findAroundSeq).not.toHaveBeenCalled();
  });

  it("reports a deleted in-history anchor as DELETED, never as before-join", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ isDeleted: true }));

    const err = await around(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneError);
    expect(isBeforeJoinError(err)).toBe(false);
  });

  it("reports a deleted-for-me in-history anchor as DELETED", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ deletedForUserIds: [USER_ID] }));

    await expect(around(service)).rejects.toBeInstanceOf(GoneError);
  });

  // NOT LOADED IS NOT NOT ACCESSIBLE. A target inside the member's history is
  // paged in exactly as before — the fix must not turn pagination into a wall.
  it("still builds the window for an accessible target, bounded by the cutoff", async () => {
    const { service, findAroundSeq } = buildService();

    await around(service);

    expect(findAroundSeq).toHaveBeenCalledWith(
      expect.objectContaining({ anchorSeq: 42, cutoff: JOINED_AT })
    );
  });

  // The boundary is a property of the MEMBERSHIP, not of the role: a moderator
  // who joined yesterday has yesterday's history, like everyone else.
  it.each(["ADMIN", "MODERATOR"])(
    "does not let a %s role bypass the boundary",
    async (role) => {
      const { service, findById } = buildService({
        member: {
          status: "ACTIVE",
          role,
          joinedAt: JOINED_AT,
          clearedAt: null,
          clearChatAt: null,
        },
      });
      findById.mockResolvedValue(message({ createdAt: BEFORE_JOIN }));

      await expect(around(service)).rejects.toMatchObject({
        messageKey: "CHAT_MESSAGE_BEFORE_JOIN",
      });
    }
  );
});

describe("message context: the two unavailable answers stay distinguishable", () => {
  const context = (service: GroupMessageService) =>
    service.getMessageContext(ROOM_ID, MSG_ID, USER_ID);

  it("answers before-join for a pre-join message", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ createdAt: BEFORE_JOIN }));

    const err = await context(service).catch((e: unknown) => e);
    expect(isBeforeJoinError(err)).toBe(true);
  });

  // A pre-join message that ALSO happens to be deleted is still answered as
  // before-join: authorization first, and the reader was never entitled to know
  // its state either way.
  it("prefers before-join over deleted when both are true", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(
      message({ createdAt: BEFORE_JOIN, isDeleted: true })
    );

    const err = await context(service).catch((e: unknown) => e);
    expect(isBeforeJoinError(err)).toBe(true);
  });

  it("answers deleted for a message that WAS inside the member's history", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ isDeleted: true }));

    const err = await context(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneError);
    expect(isBeforeJoinError(err)).toBe(false);
  });

  it("returns the message when it is inside the member's history", async () => {
    const { service } = buildService();
    await expect(context(service)).resolves.toMatchObject({ id: MSG_ID });
  });

  it("maps both refusals to their own content-level reason code", () => {
    const beforeJoin = new ForbiddenError("CHAT_MESSAGE_BEFORE_JOIN");
    const gone = new GoneError("CHAT_MESSAGE_DELETED");

    expect(isMessageContentError(beforeJoin)).toBe(true);
    expect(isMessageContentError(gone)).toBe(true);
    expect(messageContextReasonFor(beforeJoin)).toBe(
      MESSAGE_CONTEXT_REASON.beforeJoin
    );
    expect(messageContextReasonFor(gone)).toBe(MESSAGE_CONTEXT_REASON.notFound);
  });

  // An access failure must still be an access failure — it is not an answer
  // about the message, and must not be flattened into "unavailable".
  it("leaves a real access refusal to propagate", () => {
    expect(isMessageContentError(new ForbiddenError("CHAT_NOT_A_MEMBER"))).toBe(
      false
    );
  });

  it("carries no trace of the message in the denial payload", () => {
    const body = JSON.stringify(
      buildUnavailableContext({
        messageId: MSG_ID,
        roomId: ROOM_ID,
        conversationType: "GROUP",
        reason: MESSAGE_CONTEXT_REASON.beforeJoin,
      })
    );

    expect(body).toContain(MESSAGE_CONTEXT_REASON.beforeJoin);
    for (const leak of [
      "secret history",
      "Old Member",
      "usr_old_member",
      "sequenceNumber",
      "objectKey",
      "createdAt",
    ]) {
      expect(body).not.toContain(leak);
    }
  });
});

describe("forwarding cannot republish a pre-join message", () => {
  it("refuses the source without revealing whether it exists", async () => {
    const { service, findById } = buildService();
    findById.mockResolvedValue(message({ createdAt: BEFORE_JOIN }));

    await expect(
      service.forwardMessage({
        sourceMessageId: MSG_ID,
        sourceRoomId: ROOM_ID,
        targetRoomId: ROOM_ID,
        senderId: USER_ID,
      } as never)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("pins never carry pre-join content", () => {
  const pin = (over: Record<string, unknown> = {}) => ({
    messageId: MSG_ID,
    roomId: ROOM_ID,
    senderId: "usr_old_member",
    senderDisplayName: "Old Member",
    senderAvatar: "avatars/old.png",
    messageCreatedAt: AFTER_JOIN,
    pinnedAt: AFTER_JOIN,
    pinnedBy: "usr_old_member",
    originalMessageDeletedAt: null,
    contentPinned: { text: "secret history" },
    ...over,
  });

  const makePinService = (pins: unknown[], member: unknown) =>
    new GroupPinService(
      {
        findActivePinByRoom: jest.fn().mockResolvedValue(pins[0] ?? null),
        findPinsByRoom: jest.fn().mockResolvedValue(pins),
        countActivePinsByRoom: jest.fn(
          async (_r: string, cutoff?: Date) =>
            pins.filter(
              (p) =>
                !cutoff ||
                ((p as { messageCreatedAt: Date }).messageCreatedAt > cutoff &&
                  (p as { pinnedAt: Date }).pinnedAt > cutoff)
            ).length
        ),
      } as never,
      {
        findById: jest.fn().mockResolvedValue(message()),
        findLiveIds: jest.fn().mockResolvedValue(new Set([MSG_ID])),
        findHiddenIdsForUser: jest.fn().mockResolvedValue(new Set()),
      } as never,
      {} as never,
      {
        findActiveByRoomAndUser: jest.fn().mockResolvedValue(member),
      } as never,
      {} as never,
      {} as never,
      {} as never
    );

  const newMember = {
    status: "ACTIVE",
    joinedAt: JOINED_AT,
    clearedAt: null,
    clearChatAt: null,
  };

  // The case the old `pinnedAt`-only rule missed entirely: an ordinary
  // moderator action today on a message from before the member existed here.
  it("hides a pin created TODAY for a message from before the member joined", async () => {
    const svc = makePinService(
      [pin({ messageCreatedAt: BEFORE_JOIN })],
      newMember
    );
    await expect(svc.getActivePinSummary(ROOM_ID, USER_ID)).resolves.toBeNull();
  });

  it("still hides a pin whose pin EVENT predates the member's boundary", async () => {
    const svc = makePinService(
      [pin({ messageCreatedAt: BEFORE_JOIN, pinnedAt: BEFORE_JOIN })],
      newMember
    );
    await expect(svc.getActivePinSummary(ROOM_ID, USER_ID)).resolves.toBeNull();
  });

  it("keeps a pin whose message is inside the member's history", async () => {
    const svc = makePinService([pin()], newMember);
    await expect(
      svc.getActivePinSummary(ROOM_ID, USER_ID)
    ).resolves.toMatchObject({ messageId: MSG_ID });
  });

  it("filters pre-join pins out of the pin LIST, not just the banner", async () => {
    const svc = makePinService(
      [pin({ messageCreatedAt: BEFORE_JOIN })],
      newMember
    );
    await expect(svc.list(ROOM_ID, USER_ID, { limit: 20 })).resolves.toEqual(
      []
    );
  });

  it("counts only the pins the member may actually open", async () => {
    const svc = makePinService(
      [pin({ messageCreatedAt: BEFORE_JOIN })],
      newMember
    );
    await expect(svc.countPins(ROOM_ID, USER_ID)).resolves.toBe(0);
  });
});

describe("the boundary follows the CURRENT membership, not the first one ever", () => {
  // `GroupMemberRepository.upsert` stamps a fresh `joinedAt` on every re-add, so
  // the cutoff a rejoin produces is the rejoin — history from the period the
  // member was away stays out of reach.
  it("uses the newest of joinedAt / clearedAt / clearChatAt", () => {
    const rejoinedAt = new Date("2026-02-01T00:00:00.000Z");
    expect(
      getGroupVisibilityCutoff({
        joinedAt: rejoinedAt,
        clearedAt: JOINED_AT,
        clearChatAt: null,
      })
    ).toEqual(rejoinedAt);

    // A clear AFTER the join wins — the member asked for that themselves.
    const clearedAt = new Date("2026-03-01T00:00:00.000Z");
    expect(
      getGroupVisibilityCutoff({
        joinedAt: rejoinedAt,
        clearedAt,
        clearChatAt: null,
      })
    ).toEqual(clearedAt);
  });

  it("is absent for a membership that carries no boundary at all", () => {
    expect(
      getGroupVisibilityCutoff({
        joinedAt: null,
        clearedAt: null,
        clearChatAt: null,
      })
    ).toBeUndefined();
  });
});
