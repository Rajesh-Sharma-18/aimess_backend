/**
 * Admin force-logout (ban / suspend) → device-token teardown.
 *
 * A banned or suspended user can never sign back in, so any push token left
 * behind keeps delivering notifications to a dead account — and the device is
 * usually offline or uncooperative, so the cleanup MUST be entirely
 * server-side. `forceLogout` therefore has to publish `session.all_revoked`
 * alongside the DB revoke and the Redis cache bust; a revoke that publishes
 * nothing is the exact defect this suite guards against.
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
const connectionMock = { createChannel: jest.fn(async () => channelMock) };
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => connectionMock) },
  connect: jest.fn(async () => connectionMock),
}));

jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => [
      { id: "sess-1" },
      { id: "sess-2" },
    ]),
    revokeAllForUser: jest.fn(async () => ({ revokedCount: 2 })),
  },
}));
jest.mock("../../src/lib/session-active-cache.js", () => ({
  markSessionsRevoked: jest.fn(async () => undefined),
}));
jest.mock("../../src/messaging/publish-session-revoked.js", () => ({
  publishSessionDeviceRevokedSafe: jest.fn(),
  publishAllSessionsRevokedSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-admin-user-notify.js", () => ({
  publishAdminUserNotifySafe: jest.fn(),
}));

import { AdminUserEvents } from "@aimess/shared-types";

import { startAdminUserConsumer } from "../../src/messaging/admin-user-consumer.js";
import { markSessionsRevoked } from "../../src/lib/session-active-cache.js";
import { publishAllSessionsRevokedSafe } from "../../src/messaging/publish-session-revoked.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";

const sessions = sessionRepository as unknown as Record<string, jest.Mock>;
const publishAllRevoked = publishAllSessionsRevokedSafe as unknown as jest.Mock;
const markRevoked = markSessionsRevoked as unknown as jest.Mock;

type Message = { content: Buffer; fields: { redelivered: boolean } };
type ConsumeCallback = (msg: Message | null) => void;

const USER = "user-banned-1";

async function setup(): Promise<ConsumeCallback> {
  jest.clearAllMocks();
  sessions.listActiveSessionIds.mockResolvedValue([
    { id: "sess-1" },
    { id: "sess-2" },
  ]);
  await startAdminUserConsumer();
  const call = channelMock.consume.mock.calls.at(-1) as
    | [string, ConsumeCallback]
    | undefined;
  if (!call) throw new Error("consume callback was never registered");
  return call[1];
}

async function emit(
  consume: ConsumeCallback,
  type: string,
  data: object
): Promise<void> {
  consume({
    content: Buffer.from(JSON.stringify({ type, data })),
    fields: { redelivered: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
}

describe("admin.user consumer → device-token teardown", () => {
  it("publishes session.all_revoked when a ban force-logs the user out", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
    });

    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(markRevoked).toHaveBeenCalledWith(["sess-1", "sess-2"]);
    // The push tokens must go with the sessions — no exceptSessionId, the
    // account is unusable on every device.
    expect(publishAllRevoked).toHaveBeenCalledWith({ userId: USER });
    expect(channelMock.ack).toHaveBeenCalledTimes(1);
  });

  it("publishes session.all_revoked on suspend too", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_SUSPENDED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
    });

    expect(publishAllRevoked).toHaveBeenCalledWith({ userId: USER });
  });

  it("does not touch the tokens when forceLogout is not requested", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: false,
    });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(publishAllRevoked).not.toHaveBeenCalled();
  });

  it("does not revoke anything on unban", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_UNBANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
    });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(publishAllRevoked).not.toHaveBeenCalled();
  });

  it("is replay-safe: a redelivered ban publishes again without throwing", async () => {
    const consume = await setup();
    const payload = { userId: USER, actorId: "admin-1", forceLogout: true };
    await emit(consume, AdminUserEvents.USER_BANNED, payload);
    await emit(consume, AdminUserEvents.USER_BANNED, payload);

    // revokeAllForUser filters on revokedAt:null, so the second pass is a no-op
    // in the DB; re-publishing a delete for already-deleted rows is harmless.
    expect(publishAllRevoked).toHaveBeenCalledTimes(2);
    expect(channelMock.nack).not.toHaveBeenCalled();
  });

  it("dead-letters a transient failure instead of acking it", async () => {
    const consume = await setup();
    sessions.revokeAllForUser.mockRejectedValueOnce(new Error("mongo down"));

    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
    });

    // Retained, not discarded: the consumer binds a durable DLQ to its DLX.
    expect(channelMock.nack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false
    );
    expect(channelMock.ack).not.toHaveBeenCalled();
  });
});
