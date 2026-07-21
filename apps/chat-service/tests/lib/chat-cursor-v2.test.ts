/**
 * Cursor V2 for the two chat surfaces that moved off timestamp pagination:
 *   `GET /api/v2/chat/private/rooms/:roomId/messages`  (PrivateMessageController.getMessagesV2)
 *   `GET /api/v2/chat/inbox`                           (InboxController.getInboxV2)
 *
 * Both reuse the exact community-V2 contract: an OPAQUE compound keyset token
 * (`"<ms>_<id>"`), exclusive continuation, first page inclusive. These tests pin
 * the decode/encode and the boundary the repositories receive — no DB, services
 * mocked. V1 behavior is asserted unchanged alongside.
 */
import { buildRoomKeysetWhere } from "../../src/lib/pagination.js";
import { InboxController } from "../../src/api/controllers/inbox.controller.js";
import { PrivateMessageController } from "../../src/api/controllers/private-message.controller.js";

type Res = { status: jest.Mock; json: jest.Mock };

function makeRes(): Res {
  const res = {
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  } as unknown as Res;
  return res;
}

function makeReq(query: Record<string, unknown>) {
  return {
    auth: { userId: "user-1" },
    params: { roomId: "prv_room1" },
    query,
    locale: "en",
  } as never;
}

/** asyncHandler runs the body detached, so flush microtasks before asserting. */
async function invoke(
  handler: unknown,
  query: Record<string, unknown>
): Promise<Res> {
  const res = makeRes();
  await (
    handler as (req: unknown, res: unknown, next: unknown) => Promise<void>
  )(makeReq(query), res, jest.fn());
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

// ---------------------------------------------------------------------------
// buildRoomKeysetWhere — the shared inbox boundary (private + group repos)
// ---------------------------------------------------------------------------

describe("buildRoomKeysetWhere", () => {
  const ts = new Date(1784031657087);

  it("V1 default is the inclusive bare-timestamp bound (unchanged)", () => {
    expect(buildRoomKeysetWhere({ direction: "before", ts })).toEqual({
      lastMessageAt: { lte: ts, not: null },
    });
    expect(buildRoomKeysetWhere({ direction: "after", ts })).toEqual({
      lastMessageAt: { gte: ts, not: null },
    });
  });

  it("V2 bare-ms cursor (coarse jump) is exclusive, no tiebreaker", () => {
    expect(
      buildRoomKeysetWhere({ direction: "before", ts, inclusive: false })
    ).toEqual({ lastMessageAt: { lt: ts, not: null } });
  });

  it("V2 compound cursor is a strict (lastMessageAt, roomId) keyset", () => {
    expect(
      buildRoomKeysetWhere({
        direction: "before",
        ts,
        boundaryId: "prv_abc",
        inclusive: false,
      })
    ).toEqual({
      lastMessageAt: { not: null },
      OR: [
        { lastMessageAt: { lt: ts } },
        { lastMessageAt: ts, roomId: { lt: "prv_abc" } },
      ],
    });
  });

  it("forward direction flips both comparators together", () => {
    const where = buildRoomKeysetWhere({
      direction: "after",
      ts,
      boundaryId: "grp_xyz",
      inclusive: false,
    });
    expect(where.OR).toEqual([
      { lastMessageAt: { gt: ts } },
      { lastMessageAt: ts, roomId: { gt: "grp_xyz" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// InboxController — V1 vs V2
// ---------------------------------------------------------------------------

const INBOX_RESULT = {
  items: [] as unknown[],
  total: 0,
  hasMore: false,
  nextCursor: null as string | null,
};

function makeInboxController() {
  const service = { getInbox: jest.fn().mockResolvedValue(INBOX_RESULT) };
  return {
    controller: new InboxController(service as never),
    service,
  };
}

describe("InboxController.getInboxV2", () => {
  it("no cursor → newest page, inclusive, compound token requested", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInboxV2, { limit: "20" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.direction).toBe("before");
    expect(arg.boundaryId).toBeNull();
    expect(arg.inclusive).toBe(true);
    expect(arg.compoundCursor).toBe(true);
    expect(arg.limit).toBe(20);
  });

  it("before_cursor '<ms>_<roomId>' decodes on the FIRST underscore only", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInboxV2, {
      before_cursor: "1784031657087_prv_abc123",
    });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    // The roomId's own "prv_" prefix must survive the split.
    expect(arg.boundaryId).toBe("prv_abc123");
    expect(arg.inclusive).toBe(false);
    expect(arg.direction).toBe("before");
  });

  it("after_cursor pages forward", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInboxV2, {
      after_cursor: "1784031657087_grp_z9",
    });
    expect(service.getInbox.mock.calls[0]![0].direction).toBe("after");
  });

  it("bare epoch-ms cursor still decodes (coarse jump, exclusive)", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInboxV2, { before_cursor: "1784106000000" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784106000000);
    expect(arg.boundaryId).toBeNull();
    expect(arg.inclusive).toBe(false);
  });

  it("V1 getInbox is untouched: bare before_ts, no keyset args", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, { before_ts: "1784106000000" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784106000000);
    expect(arg.boundaryId).toBeUndefined();
    expect(arg.inclusive).toBeUndefined();
    expect(arg.compoundCursor).toBeUndefined();
  });

  it("V2 response envelope is byte-identical in shape to V1", async () => {
    const { controller, service } = makeInboxController();
    service.getInbox.mockResolvedValue({
      items: [{ roomId: "prv_a" }],
      total: 3,
      hasMore: true,
      nextCursor: "1784031657087_prv_a",
    });
    const res = await invoke(controller.getInboxV2, { limit: "20" });
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]![0].data;
    expect(Object.keys(body).sort()).toEqual(
      ["data", "hasMore", "nextCursor", "pagination"].sort()
    );
    expect(body.nextCursor).toBe("1784031657087_prv_a");
    expect(body.pagination.nextCursor).toBe("1784031657087_prv_a");
  });
});

// ---------------------------------------------------------------------------
// PrivateMessageController — V1 vs V2 read the cursor off different param names
// ---------------------------------------------------------------------------

const TIMELINE_RESULT = {
  items: [] as unknown[],
  hasMore: false,
  nextCursor: null as string | null,
  total: 0,
};

function makePrivateController() {
  const messageService = {
    getMessagesTimeline: jest.fn().mockResolvedValue(TIMELINE_RESULT),
    getMessagesSeq: jest.fn().mockResolvedValue(TIMELINE_RESULT),
    getMessagesAround: jest.fn().mockResolvedValue({
      items: [],
      hasMoreOlder: false,
      hasMoreNewer: false,
      olderCursor: null,
      newerCursor: null,
    }),
    enrichMessages: jest.fn().mockResolvedValue([]),
    countMessages: jest.fn().mockResolvedValue(0),
  };
  return {
    controller: new PrivateMessageController(
      messageService as never,
      {} as never,
      {} as never,
      {} as never
    ),
    messageService,
  };
}

describe("PrivateMessageController.getMessagesV2", () => {
  it("no params → newest page, inclusive (same as V1)", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessagesV2, { limit: "30" });
    expect(messageService.getMessagesTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "prv_room1",
        userId: "user-1",
        direction: "before",
        boundaryId: null,
        inclusive: true,
        limit: 30,
      })
    );
  });

  it("before_cursor carries the compound keyset; continuation is exclusive", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessagesV2, {
      before_cursor: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    const arg = messageService.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
    expect(arg.inclusive).toBe(false);
    expect(arg.direction).toBe("before");
  });

  it("after_cursor pages forward", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessagesV2, {
      after_cursor: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    expect(messageService.getMessagesTimeline.mock.calls[0]![0].direction).toBe(
      "after"
    );
  });

  it("V2 IGNORES before_ts — the timestamp params are gone from this surface", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessagesV2, { before_ts: "1784031657087" });
    const arg = messageService.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.inclusive).toBe(true); // treated as "no cursor" → newest page
    expect(arg.boundaryId).toBeNull();
  });

  it("seq + around paths are shared with V1, unchanged", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessagesV2, { before_seq: "100", limit: "30" });
    expect(messageService.getMessagesSeq).toHaveBeenCalledWith({
      roomId: "prv_room1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 30,
    });

    const fresh = makePrivateController();
    await invoke(fresh.controller.getMessagesV2, { around: "msg-9" });
    expect(fresh.messageService.getMessagesAround).toHaveBeenCalledWith({
      roomId: "prv_room1",
      userId: "user-1",
      messageId: "msg-9",
      limit: 30,
    });
  });

  it("V1 getMessages still reads before_ts (frozen)", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessages, {
      before_ts: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    const arg = messageService.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
    expect(arg.inclusive).toBe(false);
  });

  it("V1 IGNORES before_cursor (no accidental V2 leak onto V1)", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessages, {
      before_cursor: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    expect(messageService.getMessagesTimeline.mock.calls[0]![0].inclusive).toBe(
      true
    );
  });
});
