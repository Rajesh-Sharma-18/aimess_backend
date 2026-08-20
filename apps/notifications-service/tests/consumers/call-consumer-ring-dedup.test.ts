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

function ringMessage(callId = "call-1", calleeId = "callee-1") {
  return {
    content: Buffer.from(
      JSON.stringify({
        type: "call.incoming",
        data: {
          callId,
          calleeId,
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
    expect(key).toBe("push:sent:call.incoming:call-1:callee-1");
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
      "push:sent:call.incoming:call-1:callee-1"
    );
    expect(redisMock.set.mock.calls[1][0]).toBe(
      "push:sent:call.incoming:call-2:callee-1"
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

function missedMessage(callId = "call-1", calleeId = "callee-1") {
  return {
    content: Buffer.from(
      JSON.stringify({
        type: "call.missed",
        data: {
          callId,
          calleeId,
          callerId: "caller-1",
          callerName: "Alice",
          callerAvatar: "",
          callType: "AUDIO",
          missedAt: 1_700_000_060_000,
        },
      })
    ),
  };
}

describe("call.consumer — missed-call push", () => {
  it("pushes the missed-call alert and claims (callId, callee) with SET NX", async () => {
    const onMessage = await setupConsumer();

    onMessage(missedMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].type).toBe("CALL_MISSED");
    expect(push.mock.calls[0][0].userId).toBe("callee-1");
    // Structured metadata, not just a sentence — mobile navigates from this.
    expect(push.mock.calls[0][0].data).toMatchObject({
      type: "CALL_MISSED",
      callId: "call-1",
      callerId: "caller-1",
      callType: "AUDIO",
    });

    const [key, value, exFlag, ttl, nxFlag] = redisMock.set.mock.calls[0];
    expect(key).toBe("push:sent:call.missed:call-1:callee-1");
    expect(value).toBe("1");
    expect(exFlag).toBe("EX");
    expect(typeof ttl).toBe("number");
    expect(nxFlag).toBe("NX");
  });

  it("suppresses a redelivered call.missed — one buzz per missed call", async () => {
    const onMessage = await setupConsumer();
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    onMessage(missedMessage());
    await flush();
    onMessage(missedMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(channelMock.ack).toHaveBeenCalledTimes(2);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("NEVER groups: three separate missed calls push three separate times", async () => {
    const onMessage = await setupConsumer();

    onMessage(missedMessage("call-1"));
    await flush();
    onMessage(missedMessage("call-2"));
    await flush();
    onMessage(missedMessage("call-3"));
    await flush();

    expect(push).toHaveBeenCalledTimes(3);
    expect(push.mock.calls.map((c) => c[0].data.callId)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    // Distinct collapse keys, so the device stacks them instead of replacing.
    expect(new Set(push.mock.calls.map((c) => c[0].collapseKey)).size).toBe(3);
  });

  // The claim is keyed on the RECIPIENT too. A group call fans one callId out
  // to every rung member; keyed on the callId alone this silenced all but one.
  it("does not let one member's claim suppress another member's ring", async () => {
    const onMessage = await setupConsumer();

    onMessage(ringMessage("group-call", "member-a"));
    await flush();
    onMessage(ringMessage("group-call", "member-b"));
    await flush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(redisMock.set.mock.calls[0][0]).toBe(
      "push:sent:call.incoming:group-call:member-a"
    );
    expect(redisMock.set.mock.calls[1][0]).toBe(
      "push:sent:call.incoming:group-call:member-b"
    );
  });

  it("still pushes the missed alert when Redis is unreachable", async () => {
    const onMessage = await setupConsumer();
    redisMock.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    onMessage(missedMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(1);
  });

  // The recipient belongs in the missed key for exactly the reason it belongs
  // in the ring key: `fanOutUnansweredRing` loops the rung roster and publishes
  // one `call.missed` per member, all sharing a single callId. Keyed on the
  // callId alone, the first member's claim would swallow everyone else's
  // "Missed call" banner. Distinct from the "three separate missed calls" case
  // above, which varies the callId and holds the callee fixed.
  it("banners every member of a group call sharing one callId", async () => {
    const onMessage = await setupConsumer();

    onMessage(missedMessage("group-call", "member-a"));
    await flush();
    onMessage(missedMessage("group-call", "member-b"));
    await flush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(redisMock.set.mock.calls.map((c) => c[0])).toEqual([
      "push:sent:call.missed:group-call:member-a",
      "push:sent:call.missed:group-call:member-b",
    ]);
  });

  // The ring and the missed banner are two different artifacts for the same
  // call and the same person. They are separated ONLY by the `kind` segment of
  // the key, so collapsing the namespaces would make a rung call unable to
  // report itself missed.
  it("does not let the ring claim suppress the missed banner", async () => {
    const onMessage = await setupConsumer();

    onMessage(ringMessage());
    await flush();
    onMessage(missedMessage());
    await flush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][0].type).toBe("CALL_INCOMING");
    expect(push.mock.calls[1][0].type).toBe("CALL_MISSED");
    expect(redisMock.set.mock.calls.map((c) => c[0])).toEqual([
      "push:sent:call.incoming:call-1:callee-1",
      "push:sent:call.missed:call-1:callee-1",
    ]);
  });
});
