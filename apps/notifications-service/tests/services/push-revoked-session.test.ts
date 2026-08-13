/**
 * Send-time revoked-session guard (push.service.ts) + the stale-token sweeper.
 *
 * The reported defect was "devices that logged out long ago still receive
 * push". Every teardown path publishes a RabbitMQ event that deletes the row,
 * but a fire-and-forget publish can be lost (broker down, process died between
 * the DB revoke and the publish) and then NOTHING removes the token — the
 * device keeps receiving push forever.
 *
 * So the send path re-checks the shared Redis active-session cache for every
 * token that carries a sessionId, and deletes the row instead of sending. It
 * must FAIL OPEN: only an explicit "revoked" marker (`"0"`) may drop a token,
 * never a missing key, a legacy row without a sessionId, or a Redis outage —
 * otherwise a Redis blip silences push for every live device.
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

import { sessionActiveRedisKey } from "@aimess/redis";

import { runDeviceTokenSweepOnce } from "../../src/jobs/device-token-sweeper.js";
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";
import { pushToUser } from "../../src/services/push.service.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;
const send = sendPush as unknown as jest.Mock;

const USER_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: "tok-live",
    tokenType: "FCM",
    platform: "WEB",
    deviceId: "device-1",
    sessionId: "sess-live",
    ...overrides,
  };
}

/** Answer the active-session cache per sessionId ("1" active, "0" revoked). */
function cache(values: Record<string, string | null>): void {
  redisMock.get.mockImplementation(async (key: string) => {
    const entry = Object.entries(values).find(
      ([sessionId]) => sessionActiveRedisKey(sessionId) === key
    );
    return entry ? entry[1] : null;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.status = "ready";
  redisMock.get.mockResolvedValue(null);
  send.mockResolvedValue({ messageId: "msg-1", invalidToken: false });
});

describe("pushToUser — revoked-session guard", () => {
  it("does not send to a token whose session is marked revoked, and deletes it", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-dead", sessionId: "sess-dead" }),
    ]);
    cache({ "sess-dead": "0" });

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(repo.deleteByToken).toHaveBeenCalledWith("tok-dead");
  });

  it("still delivers to the live device when another device was revoked", async () => {
    repo.findTokensByUserId.mockResolvedValue([
      row({ token: "tok-dead", sessionId: "sess-dead" }),
      row({ token: "tok-live", sessionId: "sess-live" }),
    ]);
    cache({ "sess-dead": "0", "sess-live": "1" });

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-live");
    expect(repo.deleteByToken).toHaveBeenCalledWith("tok-dead");
    expect(repo.deleteByToken).not.toHaveBeenCalledWith("tok-live");
  });

  it("fails open on a missing cache entry (never seen / marker expired)", async () => {
    repo.findTokensByUserId.mockResolvedValue([row()]);
    cache({});

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(repo.deleteByToken).not.toHaveBeenCalled();
  });

  it("fails open when Redis is down", async () => {
    repo.findTokensByUserId.mockResolvedValue([row()]);
    redisMock.status = "connecting";
    redisMock.get.mockRejectedValue(new Error("redis down"));

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(repo.deleteByToken).not.toHaveBeenCalled();
  });

  it("never touches a legacy row that carries no sessionId", async () => {
    repo.findTokensByUserId.mockResolvedValue([row({ sessionId: null })]);
    cache({});

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    // The settings cache also reads Redis; only the session-active lookup must
    // be skipped for a row with nothing to look up.
    expect(redisMock.get).not.toHaveBeenCalledWith(
      expect.stringContaining("session:active")
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refreshes lastSeenAt after a delivered push so the sweeper spares it", async () => {
    repo.findTokensByUserId.mockResolvedValue([row()]);

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(repo.touchLastSeen).toHaveBeenCalledWith("tok-live");
  });

  it("does not refresh lastSeenAt for a token FCM reported dead", async () => {
    repo.findTokensByUserId.mockResolvedValue([row()]);
    send.mockResolvedValue({ messageId: null, invalidToken: true });

    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(repo.deleteByToken).toHaveBeenCalledWith("tok-live");
    expect(repo.touchLastSeen).not.toHaveBeenCalled();
  });
});

describe("device-token sweeper", () => {
  it("deletes tokens unseen past the TTL when it wins the lock", async () => {
    repo.deleteStale.mockResolvedValue(3);
    redisMock.set.mockResolvedValue("OK");

    await expect(runDeviceTokenSweepOnce()).resolves.toBe(3);
    // 60 days, from DEVICE_TOKEN_TTL_DAYS.
    expect(repo.deleteStale).toHaveBeenCalledWith(60 * 24 * 60 * 60 * 1000);
  });

  it("skips the tick when another replica holds the lock", async () => {
    redisMock.set.mockResolvedValue(null);

    await expect(runDeviceTokenSweepOnce()).resolves.toBe(0);
    expect(repo.deleteStale).not.toHaveBeenCalled();
  });

  it("runs anyway when Redis is unavailable (the delete is idempotent)", async () => {
    redisMock.set.mockRejectedValue(new Error("redis down"));
    repo.deleteStale.mockResolvedValue(1);

    await expect(runDeviceTokenSweepOnce()).resolves.toBe(1);
    expect(repo.deleteStale).toHaveBeenCalledTimes(1);
  });

  it("swallows a database failure so the interval keeps ticking", async () => {
    redisMock.set.mockResolvedValue("OK");
    repo.deleteStale.mockRejectedValue(new Error("mongo down"));

    await expect(runDeviceTokenSweepOnce()).resolves.toBe(0);
  });
});
