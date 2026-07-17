/**
 * `CommunityMessageController.getMessagesV2` — request-parameter ROUTING.
 *
 * V2 history pages on an OPAQUE `cursor` (compound `(createdAt, id)` keyset) by
 * default — the axis that works on all existing data and returns a real
 * `<ms>_<id>` nextCursor (never "0"). `before_seq`/`after_seq` are an OPT-IN
 * gap-safe seq path. `around` uses the ts-anchored window. These tests pin that
 * precedence and the exact args forwarded — no DB, service + pin service mocked.
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

function makeController() {
  const service = {
    getMessagesTimeline: jest.fn().mockResolvedValue(TIMELINE_RESULT),
    getMessagesSeqV2: jest.fn().mockResolvedValue(SEQ_RESULT),
    getMessagesAround: jest.fn().mockResolvedValue(AROUND_RESULT),
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
    controller.getMessagesV2 as unknown as (
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

describe("getMessagesV2 — param routing", () => {
  it("no params → newest page via the TIMESTAMP keyset (inclusive, no boundary) — NOT the seq path", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { limit: "40" });
    expect(service.getMessagesTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        userId: "user-1",
        direction: "before",
        boundaryId: null,
        inclusive: true, // first page includes the newest message
        limit: 40,
      })
    );
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("opaque cursor '<ms>_<id>' → OLDER page, exclusive, decoded to (ts, boundaryId)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, {
      cursor: "1784031657087_6a5629a90c4f76f4a84fc199",
      limit: "3",
    });
    const arg = service.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.direction).toBe("before");
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
    expect(arg.ts.getTime()).toBe(1784031657087); // decoded ms
    expect(arg.inclusive).toBe(false); // continuation page is exclusive
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("before_ts (migration alias) is honored the same as cursor", async () => {
    const { controller, service } = makeController();
    await invoke(controller, {
      before_ts: "1784031657087_6a5629a90c4f76f4a84fc199",
    });
    const arg = service.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784031657087);
    expect(arg.boundaryId).toBe("6a5629a90c4f76f4a84fc199");
  });

  it("bare epoch-ms cursor (no tiebreaker) still decodes (coarse jump)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { cursor: "1784106000000" });
    const arg = service.getMessagesTimeline.mock.calls[0]![0];
    expect(arg.ts.getTime()).toBe(1784106000000);
    expect(arg.boundaryId).toBe(null);
    expect(arg.inclusive).toBe(false);
  });

  it("before_seq → OPT-IN seq path, direction 'before'", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { before_seq: "100", limit: "40" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 40,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("after_seq → seq path, direction 'after'", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { after_seq: "50" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "after", seq: 50 })
    );
  });

  it("around=<id> → ts-anchored window (getMessagesAround)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { around: "msg-9", limit: "40" });
    expect(service.getMessagesAround).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      messageId: "msg-9",
      limit: 40,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("responds 200 with pinnedMessage + roomRevision attached", async () => {
    const { controller, pinService } = makeController();
    pinService.getActivePinSummary.mockResolvedValue({ id: "pin-1" });
    const res = await invoke(controller, {});
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]![0];
    expect(body.data.pinnedMessage).toEqual({ id: "pin-1" });
    expect(body.data.roomRevision).toBe(215);
  });

  it("ordinary page carries bidirectional continuation + roomRevision (Gap B)", async () => {
    const { controller } = makeController();
    const res = await invoke(controller, { limit: "30" });
    const body = res.json.mock.calls[0]![0];
    expect(body.data.hasMoreOlder).toBe(true);
    expect(body.data.hasMoreNewer).toBe(false);
    expect(body.data.olderCursor).toBe("41");
    expect(body.data.newerCursor).toBeNull();
    expect(body.data.roomRevision).toBe(261);
    // Legacy single-direction pair is untouched (direction-correct).
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
  });
});
