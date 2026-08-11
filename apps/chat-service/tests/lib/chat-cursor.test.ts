/**
 * Cursor pagination across the chat surfaces, after the V2 surface was folded
 * back into V1.
 *
 * `GET /api/chat/inbox` accepts BOTH pagination modes on one endpoint:
 *   - `before_cursor`/`after_cursor` — the opaque compound `(lastMessageAt,
 *     roomId)` keyset, EXCLUSIVE boundaries (preferred, gap-safe);
 *   - `before_ts`/`after_ts` — the legacy bare epoch-ms bound, INCLUSIVE.
 * Both return the same envelope. These tests pin that the compound mode wins when
 * both are sent, and that the legacy mode is bit-for-bit unchanged.
 *
 * `GET /api/chat/{private,groups}/…/messages` accepts `around`, then
 * `before_seq`/`after_seq`, then the compound timestamp keyset — in that
 * precedence order — and now carries `pinnedMessage` on every page.
 *
 * No DB — services mocked.
 */
import { buildRoomKeysetWhere } from "../../src/lib/pagination.js";
import { InboxController } from "../../src/api/controllers/inbox.controller.js";
import { PrivateMessageController } from "../../src/api/controllers/private-message.controller.js";
import {
  inboxQuerySchema,
  messageTimelineQuerySchema,
} from "../../src/api/validators/query.validator.js";

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

  it("default is the legacy inclusive bare-timestamp bound", () => {
    expect(buildRoomKeysetWhere({ direction: "before", ts })).toEqual({
      lastMessageAt: { lte: ts, not: null },
    });
    expect(buildRoomKeysetWhere({ direction: "after", ts })).toEqual({
      lastMessageAt: { gte: ts, not: null },
    });
  });

  it("bare-ms cursor (coarse jump) is exclusive, no tiebreaker", () => {
    expect(
      buildRoomKeysetWhere({ direction: "before", ts, inclusive: false })
    ).toEqual({ lastMessageAt: { lt: ts, not: null } });
  });

  it("compound cursor is a strict (lastMessageAt, roomId) keyset", () => {
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
// InboxController.getInbox — both pagination modes on ONE endpoint
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

describe("InboxController.getInbox", () => {
  it("no params → legacy newest page, no keyset args", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, { limit: "20" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.direction).toBe("before");
    expect(arg.boundaryId).toBeUndefined();
    expect(arg.inclusive).toBeUndefined();
    expect(arg.compoundCursor).toBeUndefined();
    expect(arg.limit).toBe(20);
  });

  it("before_cursor '<ms>_<roomId>' decodes on the FIRST underscore only", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, {
      before_cursor: "1784031657087_prv_abc123",
    });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    // The roomId's own "prv_" prefix must survive the split.
    expect(arg.boundaryId).toBe("prv_abc123");
    expect(arg.inclusive).toBe(false);
    expect(arg.compoundCursor).toBe(true);
    expect(arg.direction).toBe("before");
  });

  it("after_cursor pages forward", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, {
      after_cursor: "1784031657087_grp_z9",
    });
    expect(service.getInbox.mock.calls[0]![0].direction).toBe("after");
  });

  it("bare epoch-ms in before_cursor decodes (coarse jump, exclusive)", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, { before_cursor: "1784106000000" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784106000000);
    expect(arg.boundaryId).toBeNull();
    expect(arg.inclusive).toBe(false);
  });

  it("legacy before_ts is unchanged: bare bound, inclusive, no keyset args", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, { before_ts: "1784106000000" });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784106000000);
    expect(arg.boundaryId).toBeUndefined();
    expect(arg.inclusive).toBeUndefined();
    expect(arg.compoundCursor).toBeUndefined();
  });

  it("*_cursor wins over *_ts when a client sends both", async () => {
    const { controller, service } = makeInboxController();
    await invoke(controller.getInbox, {
      before_ts: "1700000000000",
      before_cursor: "1784031657087_prv_abc123",
    });
    const arg = service.getInbox.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.compoundCursor).toBe(true);
  });

  it("both modes return the SAME envelope (data + pagination)", async () => {
    for (const query of [
      { limit: "20" },
      { before_cursor: "1784031657087_prv_a" },
    ]) {
      const { controller, service } = makeInboxController();
      service.getInbox.mockResolvedValue({
        items: [{ roomId: "prv_a" }],
        total: 3,
        hasMore: true,
        nextCursor: "1784031657087_prv_a",
      });
      const res = await invoke(controller.getInbox, query);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0]![0].data;
      expect(body.data).toEqual([{ roomId: "prv_a" }]);
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBe("1784031657087_prv_a");
      expect(body.pagination).toEqual({
        totalData: 3,
        totalPage: 1,
        currentPage: 1,
        limit: query.limit ? 20 : 20,
        nextCursor: "1784031657087_prv_a",
        hasMore: true,
      });
    }
  });

  it("the schema accepts both cursor families but not two of one family", () => {
    expect(
      inboxQuerySchema.safeParse({ before_cursor: "1784031657087_prv_a" })
        .success
    ).toBe(true);
    expect(
      inboxQuerySchema.safeParse({ before_ts: "1784031657087" }).success
    ).toBe(true);
    expect(
      inboxQuerySchema.safeParse({
        before_cursor: "1_a",
        after_cursor: "2_b",
      }).success
    ).toBe(false);
    expect(
      inboxQuerySchema.safeParse({ before_ts: "1", after_ts: "2" }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PrivateMessageController.getMessages — one handler, every pagination axis
// ---------------------------------------------------------------------------

const TIMELINE_RESULT = {
  items: [] as unknown[],
  hasMore: false,
  nextCursor: null as string | null,
  total: 0,
};

const PIN_SUMMARY = { messageId: "msg-pinned" };

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
    getPeerReadSeq: jest.fn().mockResolvedValue(0),
    getPeerDeliveredSeq: jest.fn().mockResolvedValue(0),
  };
  const pinService = {
    getActivePinSummary: jest.fn().mockResolvedValue(PIN_SUMMARY),
  };
  return {
    controller: new PrivateMessageController(
      messageService as never,
      pinService as never,
      {} as never,
      {} as never
    ),
    messageService,
    pinService,
  };
}

describe("PrivateMessageController.getMessages", () => {
  it("no params → newest page on the timestamp keyset (inclusive)", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessages, { limit: "30" });
    expect(messageService.getMessagesSeq).not.toHaveBeenCalled();
    const arg = messageService.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.boundaryId).toBeNull();
    expect(arg.inclusive).toBe(true);
    expect(arg.limit).toBe(30);
  });

  it("before_ts decodes the compound '<ms>_<objectId>' token exclusively", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessages, {
      before_ts: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    const arg = messageService.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
    expect(arg.inclusive).toBe(false);
  });

  it("before_seq pages older, after_seq pages newer, and both beat *_ts", async () => {
    const older = makePrivateController();
    await invoke(older.controller.getMessages, {
      before_seq: "100",
      before_ts: "1784031657087",
      limit: "30",
    });
    expect(older.messageService.getMessagesTimeline).not.toHaveBeenCalled();
    expect(older.messageService.getMessagesSeq).toHaveBeenCalledWith({
      roomId: "prv_room1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 30,
    });

    const newer = makePrivateController();
    await invoke(newer.controller.getMessages, {
      after_seq: "100",
      limit: "30",
    });
    expect(newer.messageService.getMessagesSeq).toHaveBeenCalledWith({
      roomId: "prv_room1",
      userId: "user-1",
      direction: "after",
      seq: 100,
      limit: 30,
    });
  });

  it("around anchors a jump window and outranks every cursor param", async () => {
    const { controller, messageService } = makePrivateController();
    await invoke(controller.getMessages, {
      around: "msg-9",
      before_seq: "100",
      before_ts: "1784031657087",
      limit: "30",
    });
    expect(messageService.getMessagesAround).toHaveBeenCalledWith({
      roomId: "prv_room1",
      userId: "user-1",
      messageId: "msg-9",
      limit: 30,
    });
    expect(messageService.getMessagesSeq).not.toHaveBeenCalled();
    expect(messageService.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("pinnedMessage rides EVERY branch, alongside the peer watermarks", async () => {
    for (const query of [
      { limit: "30" },
      { before_seq: "100", limit: "30" },
      { around: "msg-9", limit: "30" },
    ]) {
      const { controller } = makePrivateController();
      const res = await invoke(controller.getMessages, query);
      const body = res.json.mock.calls[0]![0].data;
      expect(body.pinnedMessage).toEqual(PIN_SUMMARY);
      expect(body.peerReadSeq).toBe(0);
      expect(body.peerDeliveredSeq).toBe(0);
      // The envelope stays the V1 shape — `data`, not `items`.
      expect(body.data).toEqual([]);
      expect(body.items).toBeUndefined();
    }
  });

  it("the timeline schema accepts every axis and rejects same-family pairs", () => {
    expect(
      messageTimelineQuerySchema.safeParse({ before_ts: "1784031657087" })
        .success
    ).toBe(true);
    expect(
      messageTimelineQuerySchema.safeParse({ before_seq: "100" }).success
    ).toBe(true);
    expect(
      messageTimelineQuerySchema.safeParse({ around: "msg-9" }).success
    ).toBe(true);
    expect(
      messageTimelineQuerySchema.safeParse({ before_ts: "1", after_ts: "2" })
        .success
    ).toBe(false);
    expect(
      messageTimelineQuerySchema.safeParse({ before_seq: "1", after_seq: "2" })
        .success
    ).toBe(false);
  });
});
