/**
 * Admin force-logout (ban / suspend) → account status + device-token teardown.
 *
 * A banned or suspended user can never sign back in, so any push token left
 * behind keeps delivering notifications to a dead account — and the device is
 * usually offline or uncooperative, so the cleanup MUST be entirely
 * server-side. The revoke therefore has to publish `session.all_revoked`
 * alongside the DB revoke and the Redis cache bust; a revoke that publishes
 * nothing is the original defect this suite guards against.
 *
 * It now also guards the fix that made a permanent ban actually work: the
 * consumer must WRITE `AuthUser.status = BANNED` and set the Redis user-ban
 * flag. Until that write existed, a "banned" user could log straight back in,
 * because the ban only ever reached backoffice's own admin_db mirror.
 *
 * amqplib is faked and the consume callback is captured, so no broker is
 * needed; prisma and redis are faked so accountBanService runs for real.
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

const authUserMock = {
  findUnique: jest.fn(async () => ({
    id: "user-banned-1",
    status: "ACTIVE",
    deletedAt: null,
    updatedAt: new Date(0),
  })),
  update: jest.fn(async () => undefined),
};
jest.mock("../../src/config/prisma.js", () => ({
  prisma: { authUser: authUserMock },
}));
jest.mock("../../src/config/redis.js", () => ({
  redis: { set: jest.fn(async () => "OK"), del: jest.fn(async () => 1) },
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
jest.mock("../../src/services/audit.service.js", () => ({
  authAuditService: { record: jest.fn(async () => undefined) },
  recordAuditEventSafe: jest.fn(),
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  markUserBanned: jest.fn(async () => undefined),
  clearUserBanned: jest.fn(async () => undefined),
  publishSessionRevokedEvent: jest.fn(async () => 0),
  publishUserBanEvent: jest.fn(async () => 0),
}));

import {
  clearUserBanned,
  markUserBanned,
  publishUserBanEvent,
} from "@aimess/redis";
import { AdminUserEvents } from "@aimess/shared-types";

import { startAdminUserConsumer } from "../../src/messaging/admin-user-consumer.js";
import { markSessionsRevoked } from "../../src/lib/session-active-cache.js";
import { publishAllSessionsRevokedSafe } from "../../src/messaging/publish-session-revoked.js";
import { sessionRepository } from "../../src/repositories/session.repository.js";

const sessions = sessionRepository as unknown as Record<string, jest.Mock>;
const publishAllRevoked = publishAllSessionsRevokedSafe as unknown as jest.Mock;
const markRevoked = markSessionsRevoked as unknown as jest.Mock;
const markBanned = markUserBanned as unknown as jest.Mock;
const clearBanned = clearUserBanned as unknown as jest.Mock;
const publishBanEvent = publishUserBanEvent as unknown as jest.Mock;

type Message = { content: Buffer; fields: { redelivered: boolean } };
type ConsumeCallback = (msg: Message | null) => void;

const USER = "user-banned-1";

async function setup(): Promise<ConsumeCallback> {
  jest.clearAllMocks();
  sessions.listActiveSessionIds.mockResolvedValue([
    { id: "sess-1" },
    { id: "sess-2" },
  ]);
  authUserMock.findUnique.mockResolvedValue({
    id: USER,
    status: "ACTIVE",
    deletedAt: null,
    // Epoch-0 so no event ever looks superseded by a later write.
    updatedAt: new Date(0),
  });
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

describe("admin.user consumer → ban application + device-token teardown", () => {
  it("persists the ban and force-logs the user out", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
      at: new Date(1_000).toISOString(),
    });

    // The write that makes a ban real — without it every status guard in this
    // service compares against a column that stays ACTIVE forever.
    expect(authUserMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER },
        data: expect.objectContaining({ status: "BANNED" }),
      })
    );
    expect(markBanned).toHaveBeenCalledWith(expect.anything(), USER);

    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(markRevoked).toHaveBeenCalledWith(["sess-1", "sess-2"]);
    // The push tokens must go with the sessions — no exceptSessionId, the
    // account is unusable on every device.
    expect(publishAllRevoked).toHaveBeenCalledWith({ userId: USER });
    expect(publishBanEvent).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      "user:banned",
      expect.objectContaining({ type: "SYSTEM", userId: USER })
    );
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
    // A suspend is time-boxed; writing the permanent BANNED status here would
    // be unrecoverable, since nothing expires it.
    expect(authUserMock.update).not.toHaveBeenCalled();
    expect(markBanned).not.toHaveBeenCalled();
  });

  it("ignores forceLogout:false on a permanent ban", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: false,
    });

    // A permanent ban always ends every session — leaving a live session on a
    // permanently banned account is not a state the platform supports.
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(publishAllRevoked).toHaveBeenCalledWith({ userId: USER });
  });

  it("honours forceLogout:false on a suspend", async () => {
    const consume = await setup();
    await emit(consume, AdminUserEvents.USER_SUSPENDED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: false,
    });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(publishAllRevoked).not.toHaveBeenCalled();
  });

  it("lifts the ban on unban without revoking anything", async () => {
    const consume = await setup();
    authUserMock.findUnique.mockResolvedValue({
      id: USER,
      status: "BANNED",
      deletedAt: null,
      updatedAt: new Date(0),
    });

    await emit(consume, AdminUserEvents.USER_UNBANNED, {
      userId: USER,
      actorId: "admin-1",
    });

    expect(authUserMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      })
    );
    expect(clearBanned).toHaveBeenCalledWith(expect.anything(), USER);
    // Sessions cannot be un-revoked; the user signs in fresh.
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(publishAllRevoked).not.toHaveBeenCalled();
  });

  // admin.user.queue is at-least-once with no ordering guarantee across
  // redeliveries, so a stale ban replayed after an unban would otherwise
  // silently re-ban a reinstated account.
  it("skips a ban event superseded by a later account write", async () => {
    const consume = await setup();
    authUserMock.findUnique.mockResolvedValue({
      id: USER,
      status: "ACTIVE",
      deletedAt: null,
      updatedAt: new Date(5_000),
    });

    await emit(consume, AdminUserEvents.USER_BANNED, {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
      at: new Date(1_000).toISOString(),
    });

    expect(authUserMock.update).not.toHaveBeenCalled();
    expect(markBanned).not.toHaveBeenCalled();
    expect(channelMock.ack).toHaveBeenCalledTimes(1);
  });

  it("is replay-safe: a redelivered ban re-applies without throwing", async () => {
    const consume = await setup();
    const payload = {
      userId: USER,
      actorId: "admin-1",
      forceLogout: true,
      at: new Date(1_000).toISOString(),
    };
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
      at: new Date(1_000).toISOString(),
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
