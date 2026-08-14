/**
 * Announcement notification consumer (announcement.consumer.ts) — Queue 2 of
 * the Announcements delivery pipeline. amqplib and push.service are faked; the
 * consume callback is captured and fed directly, mirroring chat-consumer.test.ts.
 */
const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
const connectionMock = {
  createChannel: jest.fn(async () => channelMock),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => connectionMock) },
  connect: jest.fn(async () => connectionMock),
}));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUsers: jest.fn(async () => undefined),
}));

jest.mock("../../src/config/redis.js", () => ({
  redis: { set: jest.fn(async () => "OK") },
}));

import {
  startAnnouncementConsumer,
  handleAnnouncementBatch,
} from "../../src/consumers/announcement.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";
import { redis } from "../../src/config/redis.js";

const pushMany = pushToUsers as jest.Mock;
const redisMock = redis as unknown as { set: jest.Mock };

type ConsumeCallback = (msg: { content: Buffer } | null) => void;

async function setupConsumer(): Promise<ConsumeCallback> {
  await startAnnouncementConsumer();
  const calls = channelMock.consume.mock.calls as Array<
    [string, ConsumeCallback]
  >;
  return calls[calls.length - 1][1];
}

function makeMsg(data: object) {
  return {
    content: Buffer.from(
      JSON.stringify({ type: "notification.announcement_batch", data })
    ),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

const BASE = {
  announcementId: "ann-1",
  title: "Platform maintenance",
  body: "We will be down for maintenance.",
  userIds: ["u1", "u2"],
  batchId: "ann:ann-1:notify:0",
};

describe("handleAnnouncementBatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
  });

  it("fans out via pushToUsers gated on the System toggle, with the correct payload", async () => {
    await handleAnnouncementBatch(BASE);

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [userIds, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => Record<string, unknown>,
    ];
    expect(userIds).toEqual(BASE.userIds);
    const built = builderFn("u1");
    // Announcements are informational, not account-integrity: the System
    // toggle and quiet hours both apply, so no bypass.
    expect(built.bypassSettings).toBeUndefined();
    expect(built.category).toBe("systemEnabled");
    expect(built.title).toBe(BASE.title);
    expect(built.body).toBe(BASE.body);
  });

  it("duplicate execution prevention: second call with the same batchId is a no-op", async () => {
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await handleAnnouncementBatch(BASE);
    await handleAnnouncementBatch(BASE);

    expect(pushMany).toHaveBeenCalledTimes(1);
  });
});

describe("startAnnouncementConsumer wiring", () => {
  it("acks the message after successful processing", async () => {
    const consume = await setupConsumer();
    const msg = makeMsg(BASE);
    consume(msg);
    await flush();

    expect(pushMany).toHaveBeenCalledTimes(1);
    expect(channelMock.ack).toHaveBeenCalledWith(msg);
  });
});
