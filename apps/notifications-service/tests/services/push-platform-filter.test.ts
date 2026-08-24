/**
 * Platform-targeted delivery (push.service.ts `platforms`), used by device-typed
 * announcements. A device-token row exists only while its auth session does, so
 * filtering rows by platform is what "send to this user's ACTIVE Android
 * sessions only" means — a user signed in on Android, iOS and Web must get the
 * push on exactly one of them.
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
import { pushToUser } from "../../src/services/push.service.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;
const send = sendPush as unknown as jest.Mock;

const USER_ID = "11111111-1111-4111-8111-111111111111";

function row(platform: string, token: string) {
  return {
    token,
    tokenType: "FCM",
    platform,
    deviceId: token,
    sessionId: `sess-${token}`,
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function announcement(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    category: "systemEnabled" as const,
    type: "ANNOUNCEMENT",
    title: "Maintenance",
    body: "We are going down at 2am.",
    skipInbox: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.status = "ready";
  redisMock.get.mockResolvedValue(null);
  send.mockResolvedValue({ messageId: "msg-1", invalidToken: false });
  repo.findTokensByUserId.mockResolvedValue([
    row("ANDROID", "tok-android"),
    row("IOS", "tok-ios"),
    row("WEB", "tok-web"),
  ]);
});

describe("pushToUser — platforms filter", () => {
  it("delivers only to the requested platform's sessions", async () => {
    await pushToUser(announcement({ platforms: ["ANDROID"] }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].token).toBe("tok-android");
  });

  it("delivers to every session when no platform is given", async () => {
    await pushToUser(announcement());

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("sends nothing when the user has no session on that platform", async () => {
    repo.findTokensByUserId.mockResolvedValue([row("WEB", "tok-web")]);

    await pushToUser(announcement({ platforms: ["IOS"] }));

    expect(send).not.toHaveBeenCalled();
  });
});
