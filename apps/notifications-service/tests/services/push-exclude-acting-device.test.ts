/**
 * Acting-device exclusion on backstop pushes (push.service.ts `excludeSessionId`).
 *
 * The call dismissal pushes (CALL_CANCELLED / CALL_HANDLED) exist to stop a ring
 * on a device that never learned the call was over. The device that DECLINED,
 * ended or answered is not one of those: it already tore its own ring down, and
 * the push only tells it something it did itself. On iOS these are
 * high-priority pushes that WAKE that device, and the wake is what resurfaced a
 * stale ring — so the redundant delivery is not merely wasteful.
 *
 * The socket twin of these events already excludes the acting leg via
 * `handledByLegId`; a leg id never crosses the push queue, and device tokens are
 * registered against a SESSION, so `sessionId` is the only id present on both
 * the call request and the token row. `excludeDeviceId` stays for producers that
 * genuinely hold a registration deviceId (the read-dismiss push).
 */
const redisMock = {
  status: "ready",
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  get: jest.fn(async () => null as string | null),
  set: jest.fn(async () => "OK"),
  del: jest.fn(async () => 0),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(),
    deleteByToken: jest.fn(async () => undefined),
    touchLastSeen: jest.fn(async () => undefined),
    deleteStale: jest.fn(async () => 0),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ messageId: "msg-1", invalidToken: false })),
}));
jest.mock("../../src/providers/apns/sendVoipPush.js", () => ({
  sendVoipPush: jest.fn(async () => ({ messageId: null, invalidToken: false })),
}));

import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";
import { sendVoipPush } from "../../src/providers/apns/sendVoipPush.js";
import { pushToUser } from "../../src/services/push.service.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;
const send = sendPush as unknown as jest.Mock;
const sendVoip = sendVoipPush as unknown as jest.Mock;

const USER_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: "tok-1",
    tokenType: "FCM",
    platform: "IOS",
    deviceId: "device-1",
    sessionId: "sess-1",
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** A CALL_CANCELLED backstop — the shape the dismissal actually ships with. */
function cancelPush(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    category: "callEnabled" as const,
    type: "CALL_CANCELLED",
    title: "",
    body: "",
    bypassSettings: true,
    skipInbox: true,
    dataOnly: true,
    priority: "high" as const,
    collapseKey: "call:call-1",
    allowVoip: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.status = "ready";
  redisMock.get.mockResolvedValue(null);
  send.mockResolvedValue({ messageId: "msg-1", invalidToken: false });
  sendVoip.mockResolvedValue({ messageId: null, invalidToken: false });
});

// The VoIP channel was the one delivery path that received no collapse id at
// all — `pushToUser` simply did not forward `collapseKey` to it — so APNs could
// never replace a ring it was still holding with a re-published copy of itself.
describe("pushToUser — VoIP collapse id", () => {
  it("forwards collapseKey to the VoIP push as collapseId", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-voip", tokenType: "VOIP" }),
    ]);

    await pushToUser({
      userId: USER_ID,
      category: "callEnabled",
      type: "CALL_INCOMING",
      title: "Alice",
      body: "Incoming call",
      skipInbox: true,
      dataOnly: true,
      allowVoip: true,
      collapseKey: "call:call-1",
    });

    expect(sendVoip).toHaveBeenCalledTimes(1);
    expect(sendVoip.mock.calls[0][0].collapseId).toBe("call:call-1");
  });

  it("does not reach a VOIP token for an event that is not allowVoip", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-voip", tokenType: "VOIP" }),
    ]);

    await pushToUser(cancelPush());

    expect(sendVoip).not.toHaveBeenCalled();
  });
});

/**
 * A superseded PushKit token often stays ROUTABLE — APNs accepts a push for it
 * and returns success — so the dead-token pruning never fires and every ring
 * reaches the same phone twice. The second delivery lands against a callId the
 * client may already consider settled, which is what makes iOS draw a
 * caller-less "Incoming call".
 */
describe("pushToUser — superseded VoIP tokens", () => {
  const ring = {
    userId: USER_ID,
    category: "callEnabled" as const,
    type: "CALL_INCOMING",
    title: "Alice",
    body: "Incoming call",
    skipInbox: true,
    dataOnly: true,
    allowVoip: true,
    collapseKey: "call:call-1",
  };

  it("rings a device once when it has an old and a new VoIP token", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({
        token: "tok-voip-old",
        tokenType: "VOIP",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      }),
      row({
        token: "tok-voip-new",
        tokenType: "VOIP",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);

    await pushToUser(ring);

    expect(sendVoip).toHaveBeenCalledTimes(1);
    expect(sendVoip.mock.calls[0][0].token).toBe("tok-voip-new");
  });

  it("still rings every DISTINCT device", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-iphone", tokenType: "VOIP", deviceId: "iphone" }),
      row({ token: "tok-ipad", tokenType: "VOIP", deviceId: "ipad" }),
    ]);

    await pushToUser(ring);

    expect(sendVoip).toHaveBeenCalledTimes(2);
  });

  // Null deviceIds are indistinguishable devices, not one device. Collapsing
  // them would silence real phones.
  it("keeps every VoIP token that carries no deviceId", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-a", tokenType: "VOIP", deviceId: null }),
      row({ token: "tok-b", tokenType: "VOIP", deviceId: null }),
    ]);

    await pushToUser(ring);

    expect(sendVoip).toHaveBeenCalledTimes(2);
  });

  // FCM tokens rotate and self-heal via invalidToken pruning — collapsing them
  // is not this function's job and would change unrelated delivery.
  it("leaves two FCM tokens on one device alone", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({
        token: "tok-fcm-old",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      }),
      row({
        token: "tok-fcm-new",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);

    await pushToUser(ring);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not drop the FCM token of a device whose VoIP token was collapsed", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({
        token: "tok-voip-old",
        tokenType: "VOIP",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      }),
      row({
        token: "tok-voip-new",
        tokenType: "VOIP",
        deviceId: "iphone",
        lastSeenAt: new Date("2026-02-01T00:00:00Z"),
      }),
      row({ token: "tok-fcm", deviceId: "iphone" }),
    ]);

    await pushToUser(ring);

    expect(sendVoip).toHaveBeenCalledTimes(1);
    expect(sendVoip.mock.calls[0][0].token).toBe("tok-voip-new");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-fcm");
  });
});

describe("pushToUser — excludeSessionId", () => {
  it("skips the acting device and still reaches the user's other devices", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-acted", sessionId: "sess-acted" }),
      row({ token: "tok-sibling", sessionId: "sess-sibling" }),
    ]);

    await pushToUser(cancelPush({ excludeSessionId: "sess-acted" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-sibling");
  });

  it("sends to every device when no acting session is given", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-a", sessionId: "sess-a" }),
      row({ token: "tok-b", sessionId: "sess-b" }),
    ]);

    await pushToUser(cancelPush());

    expect(send).toHaveBeenCalledTimes(2);
  });

  // "Unknown session" must never be read as "the acting one" — a legacy row
  // predating session stamping would otherwise be silently cut off from every
  // dismissal push.
  it("never excludes a legacy token row that carries no sessionId", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-legacy", sessionId: null }),
    ]);

    await pushToUser(cancelPush({ excludeSessionId: "sess-acted" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-legacy");
  });

  it("excludes every token of the acting session, not just the first", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      // One device legitimately holds both an FCM and a VOIP token.
      row({ token: "tok-acted-fcm", sessionId: "sess-acted" }),
      row({
        token: "tok-acted-voip",
        sessionId: "sess-acted",
        tokenType: "VOIP",
      }),
      row({ token: "tok-sibling", sessionId: "sess-sibling" }),
    ]);

    await pushToUser(cancelPush({ excludeSessionId: "sess-acted" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-sibling");
  });

  it("still honours excludeDeviceId, which other producers use", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-acted", deviceId: "device-acted" }),
      row({ token: "tok-sibling", deviceId: "device-sibling" }),
    ]);

    await pushToUser(cancelPush({ excludeDeviceId: "device-acted" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-sibling");
  });
});
