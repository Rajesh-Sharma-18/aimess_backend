/**
 * Ring-push de-duplication in call.consumer.ts.
 *
 * The consumer acks INSIDE a detached async task with `prefetch(20)`, so a
 * restart, channel drop or broker reconnect mid-flight leaves the message
 * unacked and RabbitMQ redelivers it. That redelivery is a genuine second
 * `call.incoming` — a second VoIP push, a second PushKit delivery — and on iOS
 * the second copy can land against a callId the client already considers
 * settled, which is what makes it fabricate a caller-less "Incoming call".
 *
 * `apns-collapse-id` only helps while APNs still HOLDS the first copy, so the
 * producer-side claim below is the half that always works.
 *
 * It must FAIL OPEN: a ring never sent is a missed call, a ring sent twice is
 * noise. Redis down => send.
 *
 * amqplib, redis and push.service are faked; the consume callback is captured
 * and fed directly so tests run without a real broker.
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

const redisMock = {
  status: "ready",
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  get: jest.fn(async () => null as string | null),
  set: jest.fn(async () => "OK" as string | null),
  del: jest.fn(async () => 0),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));

import { startCallConsumer } from "../../src/consumers/call.consumer.js";
import { pushToUser } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;

type ConsumeCallback = (msg: { content: Buffer } | null) => void;

async function setupConsumer(): Promise<ConsumeCallback> {
  await startCallConsumer();
  const calls = channelMock.consume.mock.calls as Array<
    [string, ConsumeCallback]
  >;
  return calls[calls.length - 1][1];
}

function ringMessage(callId = "call-1") {
  return {
    content: Buffer.from(
      JSON.stringify({
        type: "call.incoming",
        data: {
          callId,
          calleeId: "callee-1",
          callerId: "caller-1",
          callerName: "Alice",
          callerAvatar: "",
          callType: "AUDIO",
          initiatedAt: 1_700_000_000_000,
          livekitUrl: "wss://lk.invalid",
          token: "lk-token",
        },
      })
    ),
  };
}

/** The consumer processes inside a detached async task — let it settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.set.mockResolvedValue("OK");
});

describe("call.consumer — ring push de-duplication", () => {
  it("pushes the ring once and claims the callId with SET NX + a TTL", async () => {
    const onMessage = await setupConsumer();

    onMessage(ringMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].type).toBe("CALL_INCOMING");

    const [key, value, exFlag, ttl, nxFlag] = redisMock.set.mock.calls[0];
    expect(key).toBe("push:sent:call.incoming:call-1");
    expect(value).toBe("1");
    expect(exFlag).toBe("EX");
    expect(typeof ttl).toBe("number");
    expect(ttl).toBeGreaterThan(0);
    expect(nxFlag).toBe("NX");
  });

  it("suppresses a redelivery of the SAME callId — the duplicate ring", async () => {
    const onMessage = await setupConsumer();

    // First delivery wins the claim, the redelivery loses it.
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    onMessage(ringMessage());
    await flush();
    onMessage(ringMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
    // Still acked — a suppressed duplicate is handled, not failed.
    expect(channelMock.ack).toHaveBeenCalledTimes(2);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("does not let one call's claim suppress a different call", async () => {
    const onMessage = await setupConsumer();

    onMessage(ringMessage("call-1"));
    await flush();
    onMessage(ringMessage("call-2"));
    await flush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(redisMock.set.mock.calls[0][0]).toBe(
      "push:sent:call.incoming:call-1"
    );
    expect(redisMock.set.mock.calls[1][0]).toBe(
      "push:sent:call.incoming:call-2"
    );
  });

  // FAIL OPEN. A dedup outage must never cost a real ring.
  it("still pushes the ring when Redis is unreachable", async () => {
    const onMessage = await setupConsumer();
    redisMock.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    onMessage(ringMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
  });

  // The claim guards the RING only — dismissals must always get through, or a
  // device that missed the socket event keeps ringing.
  it("never suppresses a cancel for a callId whose ring was already claimed", async () => {
    const onMessage = await setupConsumer();

    onMessage(ringMessage());
    await flush();
    redisMock.set.mockClear();

    onMessage({
      content: Buffer.from(
        JSON.stringify({
          type: "call.cancelled",
          data: { callId: "call-1", calleeId: "callee-1", reason: "declined" },
        })
      ),
    });
    await flush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[1][0].type).toBe("CALL_CANCELLED");
    // The dismissal takes no claim at all.
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});
