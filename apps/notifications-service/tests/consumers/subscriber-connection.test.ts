/**
 * Redis subscribers must inherit the service's own connection settings.
 *
 * `connectRedis` returns a process-wide SINGLETON built from whichever options
 * reach it FIRST. Both of these consumers called it again with a PARTIAL copy
 * of `config/redis.ts` — host, port and password, but no `tls` — so a consumer
 * that started before the first cache read decided the whole process's
 * connection and silently dropped TLS from it. Redis pub/sub is this platform's
 * realtime fan-out, so that is message bodies in the clear.
 *
 * They now duplicate the configured client instead, which clones host, port,
 * auth and TLS together and cannot drift from it. (Duplicating rather than
 * sharing is still required: ioredis refuses ordinary commands on a client in
 * subscriber mode, which is what previously killed every settings cache read
 * and write in the service.)
 */
const duplicate = jest.fn();
const configuredClient = { duplicate, status: "ready" };

jest.mock("../../src/config/redis.js", () => ({
  redis: configuredClient,
}));
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: { updateLocaleBySession: jest.fn(async () => 0) },
}));
jest.mock("../../src/services/chat-push-coalescer.js", () => ({
  dropPendingChatMessage: jest.fn(),
  updatePendingChatMessage: jest.fn(),
}));

import { startPendingPushSync } from "../../src/consumers/pending-push-sync.js";
import { startSessionLocaleConsumer } from "../../src/consumers/session-locale.consumer.js";

/** A subscriber stub that records what it was asked to listen to. */
function makeSubscriber() {
  return {
    status: "ready",
    connect: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined),
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("consumer Redis connections", () => {
  it("pending-push-sync subscribes on a duplicate of the configured client", () => {
    const sub = makeSubscriber();
    duplicate.mockReturnValue(sub);

    startPendingPushSync();

    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(sub.on).toHaveBeenCalledWith("pmessage", expect.any(Function));
  });

  it("session-locale subscribes on a duplicate of the configured client", async () => {
    const sub = makeSubscriber();
    duplicate.mockReturnValue(sub);

    await startSessionLocaleConsumer();

    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalled();
    expect(sub.on).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
