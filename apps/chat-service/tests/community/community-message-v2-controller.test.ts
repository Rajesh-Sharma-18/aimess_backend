/**
 * `CommunityMessageController.getMessagesV2` — request-parameter ROUTING.
 *
 * V2 replaces V1's timestamp cursor with the sequence cursor, so the controller's
 * only new logic is picking the right service call from the query params. These
 * unit tests pin that precedence (around → before_seq/after_seq → newest) and the
 * exact args forwarded — no DB, service + pin service mocked.
 */
import { CommunityMessageController } from "../../src/api/controllers/community-message.controller.js";

type Res = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeRes(): Res {
  const res: Res = {
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

const SEQ_RESULT = {
  items: [] as unknown[],
  hasMore: false,
  nextCursor: null as string | null,
  total: 0,
};
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
    getMessagesSeqV2: jest.fn().mockResolvedValue(SEQ_RESULT),
    getMessagesAroundV2: jest.fn().mockResolvedValue(AROUND_RESULT),
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
  return res;
}

describe("getMessagesV2 — param routing", () => {
  it("around=<id> → getMessagesAroundV2 (seq path NOT called)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { around: "msg-9", limit: "20" });
    expect(service.getMessagesAroundV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      messageId: "msg-9",
      limit: 20,
    });
    expect(service.getMessagesSeqV2).not.toHaveBeenCalled();
  });

  it("before_seq → seq path, direction 'before', exclusive boundary", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { before_seq: "100", limit: "30" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: 100,
      limit: 30,
    });
    expect(service.getMessagesAroundV2).not.toHaveBeenCalled();
  });

  it("after_seq → seq path, direction 'after'", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { after_seq: "50", limit: "30" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "after",
      seq: 50,
      limit: 30,
    });
  });

  it("no cursor → newest page (direction 'before', seq null)", async () => {
    const { controller, service } = makeController();
    await invoke(controller, { limit: "30" });
    expect(service.getMessagesSeqV2).toHaveBeenCalledWith({
      roomId: "room-1",
      userId: "user-1",
      direction: "before",
      seq: null,
      limit: 30,
    });
  });

  it("responds 200 with the pinnedMessage attached", async () => {
    const { controller, pinService } = makeController();
    pinService.getActivePinSummary.mockResolvedValue({ id: "pin-1" });
    const res = await invoke(controller, { limit: "30" });
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]![0];
    expect(body.data.pinnedMessage).toEqual({ id: "pin-1" });
  });
});
