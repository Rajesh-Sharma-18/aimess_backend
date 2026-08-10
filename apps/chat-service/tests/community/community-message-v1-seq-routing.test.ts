/**
 * `CommunityMessageController.getMessages` (V1) — `before_seq`/`after_seq` ROUTING.
 *
 * The web client pages community history on the monotonic `sequenceNumber`
 * axis, exactly like private/group. V1 previously accepted only
 * `before_ts`/`after_ts`/`around`, so a `before_seq` request fell through to the
 * NEWEST page with a 200 — the client re-derived the same cursor, filtered the
 * page as duplicates, and history never scrolled past page one. These tests pin
 * the seq routing, its precedence over the `*_ts` params, and the fact that the
 * V1 envelope (data/hasMore/nextCursor + bidirectional cursors) is unchanged.
 */
import { CommunityMessageController } from "../../src/api/controllers/community-message.controller.js";
import { communityTimelineQuerySchema } from "../../src/api/validators/query.validator.js";

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

const PAGE_RESULT = {
  items: [{ id: "m-1" }] as unknown[],
  hasMore: true,
  nextCursor: "41",
  total: 120,
  cursors: {
    hasMoreOlder: true,
    hasMoreNewer: false,
    olderCursor: "41",
    newerCursor: null as string | null,
  },
  roomRevision: 261,
};

function makeController() {
  const service = {
    getMessagesTimeline: jest.fn().mockResolvedValue(PAGE_RESULT),
    getMessagesSeqV2: jest.fn().mockResolvedValue(PAGE_RESULT),
    getMessagesSince: jest.fn().mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    }),
    getMessagesAround: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      hasMoreOlder: false,
      hasMoreNewer: false,
      olderCursor: null,
      newerCursor: null,
    }),
  };
  const pinService = { getActivePinSummary: jest.fn().mockResolvedValue(null) };
  const controller = new CommunityMessageController(
    service as never,
    pinService as never,
    {} as never,
    {} as never
  );
  return { controller, service };
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
  // asyncHandler runs the body detached — flush microtasks so it reaches res.
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

describe("communityTimelineQuerySchema", () => {
  // Zod STRIPS unknown keys: while before_seq was absent from the schema the
  // param never reached the controller and every page was the newest page.
  it("keeps before_seq / after_seq instead of stripping them", () => {
    expect(communityTimelineQuerySchema.parse({ before_seq: "100" })).toEqual({
      before_seq: 100,
      limit: 30,
    });
    expect(communityTimelineQuerySchema.parse({ after_seq: "50" })).toEqual({
      after_seq: 50,
      limit: 30,
    });
  });

  it("rejects before_seq + after_seq together", () => {
    expect(
      communityTimelineQuerySchema.safeParse({ before_seq: 1, after_seq: 2 })
        .success
    ).toBe(false);
  });
});

describe("getMessages (V1) — seq cursor routing", () => {
  it("before_seq → seq keyset, direction 'before'", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { before_seq: "100", limit: "30" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 30,
    });
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("after_seq → seq keyset, direction 'after' (NOT the after_ts sync path)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { after_seq: "50" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "after", seq: 50 })
    );
    expect(service.getMessagesSince).not.toHaveBeenCalled();
  });

  it("seq wins over the *_ts cursors when both are sent", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { before_seq: "7", before_ts: "1782133107521" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 7 })
    );
    expect(service.getMessagesTimeline).not.toHaveBeenCalled();
  });

  it("around still wins over seq (jump-to-message)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { around: "msg-9", before_seq: "7" });
    expect(service.getMessagesAround).toHaveBeenCalled();
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("no cursor → newest page on the timestamp keyset (V1 default, unchanged)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { limit: "30" });
    expect(service.getMessagesTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "before", inclusive: true })
    );
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("seq page keeps the V1 envelope: data/hasMore/nextCursor + both cursors", async () => {
    const { controller } = makeController();
    const res = await invoke(controller, { before_seq: "100", limit: "30" });
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]![0].data;
    expect(body.data).toEqual([{ id: "m-1" }]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("41");
    // Feedable back verbatim as the next before_seq — a NUMBER-parsable cursor.
    expect(body.olderCursor).toBe("41");
    expect(body.hasMoreOlder).toBe(true);
    expect(body.roomRevision).toBe(261);
    expect(body.pinnedMessage).toBeNull();
  });
});
