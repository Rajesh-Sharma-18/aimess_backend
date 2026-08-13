/**
 * Device-token teardown on session revocation (session.consumer.ts).
 *
 * The consumer is the ONLY path that removes a push token when a session dies
 * server-side (remote "Logout Device", sign-out-all, admin force-logout,
 * account deletion) — the browser cannot delete its own row once the JWT is
 * gone. What it matches on therefore has to be exact:
 *
 *   - session.device_revoked deletes by sessionId (the field stamped on the row
 *     at registration). deviceId is only a fallback for rows registered before
 *     sessionId existed — auth-service's Session.deviceId is a
 *     sha256(userAgent|ip) fingerprint that never equals the client-generated
 *     deviceId, so matching on it alone deletes nothing.
 *   - session.all_revoked honours exceptSessionId, so "sign out from all OTHER
 *     devices" leaves the still-signed-in caller's token in place.
 *
 * amqplib is faked and the consume callback is captured, so no broker is needed.
 */

const channelMock = {
  assertExchange: jest.fn(async () => undefined),
  assertQueue: jest.fn(async () => undefined),
  bindQueue: jest.fn(async () => undefined),
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

jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    deleteAllByUserId: jest.fn(async () => undefined),
    deleteByUserIdAndSessionId: jest.fn(async () => 1),
    deleteByUserIdAndDeviceId: jest.fn(async () => undefined),
  },
}));

import { startSessionConsumer } from "../../src/consumers/session.consumer.js";
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;

type Message = { content: Buffer; fields: { redelivered: boolean } };
type ConsumeCallback = (msg: Message | null) => void;

const USER = "user-1";

async function setup(): Promise<ConsumeCallback> {
  jest.clearAllMocks();
  await startSessionConsumer();
  const call = channelMock.consume.mock.calls.at(-1) as
    | [string, ConsumeCallback]
    | undefined;
  if (!call) throw new Error("consume callback was never registered");
  return call[1];
}

function message(body: string, redelivered = false): Message {
  return { content: Buffer.from(body), fields: { redelivered } };
}

/** Feed one event and wait for the consumer's async handler to settle. */
async function emit(
  consume: ConsumeCallback,
  type: string,
  data: object,
  redelivered = false
): Promise<void> {
  consume(message(JSON.stringify({ type, data }), redelivered));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("session consumer → device token teardown", () => {
  it("deletes by sessionId on session.device_revoked", async () => {
    const consume = await setup();
    await emit(consume, "session.device_revoked", {
      userId: USER,
      sessionId: "sess-1",
    });

    expect(repo.deleteByUserIdAndSessionId).toHaveBeenCalledWith(
      USER,
      "sess-1"
    );
    expect(repo.deleteByUserIdAndDeviceId).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledTimes(1);
  });

  it("also sweeps by deviceId so pre-sessionId rows are not orphaned", async () => {
    const consume = await setup();
    await emit(consume, "session.device_revoked", {
      userId: USER,
      sessionId: "sess-1",
      deviceId: "fingerprint-abc",
    });

    expect(repo.deleteByUserIdAndSessionId).toHaveBeenCalledWith(
      USER,
      "sess-1"
    );
    expect(repo.deleteByUserIdAndDeviceId).toHaveBeenCalledWith(
      USER,
      "fingerprint-abc"
    );
  });

  it("wipes every token on session.all_revoked (logout-all / account deletion)", async () => {
    const consume = await setup();
    await emit(consume, "session.all_revoked", { userId: USER });

    expect(repo.deleteAllByUserId).toHaveBeenCalledWith(USER, undefined);
  });

  it("spares the caller's token when all_revoked carries exceptSessionId", async () => {
    const consume = await setup();
    await emit(consume, "session.all_revoked", {
      userId: USER,
      exceptSessionId: "sess-current",
    });

    expect(repo.deleteAllByUserId).toHaveBeenCalledWith(USER, "sess-current");
  });

  it("dead-letters a malformed message instead of acking it", async () => {
    const consume = await setup();
    consume(message("not json"));
    await new Promise((resolve) => setImmediate(resolve));

    // requeue=false: retrying unparseable bytes can never succeed.
    expect(channelMock.nack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false
    );
    expect(channelMock.ack).not.toHaveBeenCalled();
  });

  // A dead-lettered delete used to vanish: the DLX was asserted but no queue
  // was ever bound to it, so RabbitMQ dropped the message and the device kept
  // its push token with nothing left to replay.
  it("binds a durable dead-letter queue to the DLX", async () => {
    await setup();

    expect(channelMock.assertQueue).toHaveBeenCalledWith("session.queue.dlq", {
      durable: true,
    });
    expect(channelMock.bindQueue).toHaveBeenCalledWith(
      "session.queue.dlq",
      "session.queue.dlx",
      "session.queue.dead"
    );
  });

  it("requeues a transient failure once instead of dead-lettering it", async () => {
    const consume = await setup();
    repo.deleteByUserIdAndSessionId.mockRejectedValueOnce(
      new Error("mongo down")
    );

    await emit(consume, "session.device_revoked", {
      userId: USER,
      sessionId: "sess-1",
    });

    expect(channelMock.nack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      true
    );
    expect(channelMock.ack).not.toHaveBeenCalled();
  });

  it("dead-letters a redelivered message that fails again", async () => {
    const consume = await setup();
    repo.deleteByUserIdAndSessionId.mockRejectedValueOnce(
      new Error("mongo still down")
    );

    await emit(
      consume,
      "session.device_revoked",
      { userId: USER, sessionId: "sess-1" },
      true
    );

    expect(channelMock.nack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false
    );
  });
});
