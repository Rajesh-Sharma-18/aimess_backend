/**
 * `CommunityMessageController.getMessages` — request-parameter ROUTING.
 *
 * One endpoint, four pagination axes, in this precedence order:
 *   `around`                   → jump-to-message window
 *   `before_seq` / `after_seq` → gap-safe sequenceNumber keyset (opt-in; folded in
 *                                 from the retired V2 surface)
 *   `after_ts`                 → incremental sync (updatedAt >=, incl. tombstones)
 *   `before_ts` / none         → compound `(createdAt, _id)` history keyset
 *
 * These tests pin the param routing, the exact service args, and that the response
 * envelope stays the V1 shape (`data` + `pagination`) on every branch — no DB,
 * service + pin service mocked.
 */
import { CommunityMessageController } from "../../src/api/controllers/community-message.controller.js";

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
    params: { roomId: "room-1" },
    query,
    locale: "en",
  } as never;
}

const TIMELINE_RESULT = {
  items: [] as unknown[],
  hasMore: false,
  nextCursor: null as string | null,
  total: 0,
  cursors: {
    hasMoreOlder: true,
    hasMoreNewer: false,
    olderCursor: "41" as string | null,
    newerCursor: null as string | null,
  },
  roomRevision: 261,
};
const SEQ_RESULT = { ...TIMELINE_RESULT };
const AROUND_RESULT = {
  items: [] as unknown[],
  total: 0,
  hasMoreOlder: false,
  hasMoreNewer: false,
  olderCursor: null as string | null,
  newerCursor: null as string | null,
};
const SINCE_RESULT = {
  items: [] as unknown[],
  hasMore: false,
  nextCursor: null as string | null,
};

function makeController() {
  const service = {
    getMessagesTimeline: jest.fn().mockResolvedValue(TIMELINE_RESULT),
    getMessagesSeqKeyset: jest.fn().mockResolvedValue(SEQ_RESULT),
    getMessagesAround: jest.fn().mockResolvedValue(AROUND_RESULT),
    getMessagesSince: jest.fn().mockResolvedValue(SINCE_RESULT),
    getRoomRevision: jest.fn().mockResolvedValue(215),
  };
  const pinService = {
    getActivePinSummary: jest.fn().mockResolvedValue(null),
  };
  const controller = new CommunityMessageController(
    service as never,
    pinService as never,
    {} as never,
    {} as never
  );
  return { controller, service, pinService };
}

async function invoke(
  controller: CommunityMessageController,
  query: Record<string, unknown>
) {
  const res = makeRes();
  await (
    controller.getMessages as unknown as (
      req: unknown,
      res: unknown,
      next: unknown
    ) => Promise<void>
  )(makeReq(query), res, jest.fn());
  // asyncHandler runs the body detached (it doesn't return the promise), so flush
  // pending microtasks/timers to let the handler reach res.status/json.
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

describe("getMessages — param routing", () => {
  it("no params → newest page on the TIMESTAMP keyset (inclusive)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { limit: "30" });
    const arg = service.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.direction).toBe("before");
    expect(arg.boundaryId).toBeNull();
    expect(arg.inclusive).toBe(true);
    expect(arg.limit).toBe(30);
    expect(service.getMessagesSeqKeyset).not.toHaveBeenCalled();
  });

  it("before_ts decodes the compound '<ms>_<objectId>' token exclusively", async () => {
    const { controller, service } = makeController();
    await invoke(controller, {
      before_ts: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    const arg = service.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
    expect(arg.inclusive).toBe(false);
  });

  it("after_ts → incremental sync, not the history keyset", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { after_ts: "1784031657087" });
    expect(service.getMessagesSince).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      fromTs: new Date(1784031657087),
      limit: 30,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("before_seq → seq path, direction 'before', outranking before_ts", async () => {
    const { controller, service } = makeController();
    await invoke(controller, {
      before_seq: "100",
      before_ts: "1784031657087",
      limit: "40",
    });
    expect(service.getMessagesSeqKeyset).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 40,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("after_seq → seq path, direction 'after', outranking after_ts sync", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { after_seq: "50", after_ts: "1784031657087" });
    expect(service.getMessagesSeqKeyset).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "after", seq: 50 })
    );
    expect(service.getMessagesSince).not.toHaveBeenCalled();
  });

  it("around=<id> → jump window, outranking every cursor param", async () => {
    const { controller, service } = makeController();
    await invoke(controller, {
      around: "msg-9",
      before_seq: "100",
      before_ts: "1784031657087",
      limit: "40",
    });
    expect(service.getMessagesAround).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      messageId: "msg-9",
      limit: 40,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
    expect(service.getMessagesSeqKeyset).not.toHaveBeenCalled();
  });

  it("responds 200 with pinnedMessage + roomRevision attached", async () => {
    const { controller, pinService } = makeController();
    pinService.getActivePinSummary.mockResolvedValue({ id: "pin-1" });
    const res = await invoke(controller, {});
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]![0];
    expect(body.data.pinnedMessage).toEqual({ id: "pin-1" });
    expect(body.data.roomRevision).toBe(261);
  });

  it("the seq branch returns the SAME V1 envelope as the timestamp branch", async () => {
    const { controller } = makeController();
    const res = await invoke(controller, { before_seq: "100", limit: "30" });
    const body = res.json.mock.calls[0]![0].data;
    // `data`, not `items` — V1 clients keep the envelope they already parse.
    expect(body.data).toEqual([]);
    expect(body.items).toBeUndefined();
    expect(body.pagination).toEqual({
      totalData: 0,
      totalPage: 1,
      currentPage: 1,
      limit: 30,
      nextCursor: null,
      hasMore: false,
    });
    // Bidirectional continuation rides along additively.
    expect(body.hasMoreOlder).toBe(true);
    expect(body.hasMoreNewer).toBe(false);
    expect(body.olderCursor).toBe("41");
    expect(body.roomRevision).toBe(261);
  });
});
