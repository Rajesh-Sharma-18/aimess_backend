/**
 * `CommunityMessageController.getMessagesV2` — request-parameter ROUTING.
 *
 * V2 pages on `sequenceNumber` ONLY — `before_seq`/`after_seq`/`around`, or the
 * newest page when all are omitted. The timestamp keyset is gone: it stepped over
 * rows sharing a millisecond and dropped them silently. These tests pin the param
 * routing, the exact service args, and the response envelope — no DB, service +
 * pin service mocked.
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
  it("no params → newest page on the SEQ keyset (seq null) — the timestamp path is gone", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { limit: "40" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: null,
      limit: 40,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("before_seq → seq path, direction 'before'", async () => {
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

  it("around=<id> → jump window (getMessagesAround)", async () => {
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
    // Ordinary pages carry the revision from the timeline read; 261 = the seq-path fixture.
    expect(body.data.roomRevision).toBe(261);
  });

  it("ordinary page carries the V2 timeline envelope: items + one page block", async () => {
    const { controller } = makeController();
    const res = await invoke(controller, { limit: "30" });
    const body = res.json.mock.calls[0]![0];
    expect(Object.keys(body.data).sort()).toEqual(
      ["items", "page", "pinnedMessage", "roomRevision"].sort()
    );
    // Both directions on every page, boundaries as NUMBERS on the seq axis.
    expect(body.data.page).toEqual({
      limit: 30,
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderSeq: 41,
      newerSeq: null,
    });
    expect(body.data.roomRevision).toBe(261);
  });

  it("drops every V1 duplication: no data.data, no pagination, no top-level cursors", async () => {
    const { controller } = makeController();
    const res = await invoke(controller, { limit: "30" });
    const body = res.json.mock.calls[0]![0].data;
    for (const retired of [
      "data",
      "pagination",
      "hasMore",
      "nextCursor",
      "hasMoreOlder",
      "olderCursor",
      "newerCursor",
    ]) {
      expect(body[retired]).toBeUndefined();
    }
  });
});
