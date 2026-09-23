/**
 * Retracting an already-delivered chat push when its message is deleted for
 * everyone.
 *
 * The contract is: only the devices that were actually pushed are told, only
 * for the deleted message, exactly once however many times the delete event is
 * replayed, and never at the cost of the delete itself (Redis down = silent
 * no-op, not a throw).
 */
const redisMock = {
  status: "ready",
  on: jest.fn(),
  smembers: jest.fn(async (_key: string) => [] as string[]),
  del: jest.fn(async () => 1),
  pipeline: jest.fn(),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
}));

import { pushToUser } from "../../src/services/push.service.js";
import {
  recordPushedMessages,
  retractMessagePush,
} from "../../src/services/push-retraction.js";

const push = pushToUser as unknown as jest.Mock;

const pipelineMock = () => {
  const p = {
    sadd: jest.fn(() => p),
    expire: jest.fn(() => p),
    exec: jest.fn(async () => []),
  };
  return p;
};

beforeEach(() => {
  push.mockClear();
  redisMock.smembers.mockReset().mockResolvedValue([]);
  redisMock.del.mockClear();
  redisMock.pipeline.mockReset();
});

describe("recordPushedMessages", () => {
  it("stores the recipient under every message the burst stood for", async () => {
    const p = pipelineMock();
    redisMock.pipeline.mockReturnValue(p);

    await recordPushedMessages("u1", ["m1", "m2", "m1"]);

    expect(p.sadd.mock.calls).toEqual([
      ["push:msg:{m1}", "u1"],
      ["push:msg:{m2}", "u1"],
    ]);
    expect(p.expire).toHaveBeenCalledTimes(2);
  });

  it("is a no-op without a user or ids, and never throws on a Redis failure", async () => {
    redisMock.pipeline.mockImplementation(() => {
      throw new Error("redis down");
    });

    await expect(recordPushedMessages("", ["m1"])).resolves.toBeUndefined();
    await expect(recordPushedMessages("u1", [])).resolves.toBeUndefined();
    await expect(recordPushedMessages("u1", ["m1"])).resolves.toBeUndefined();
  });
});

describe("retractMessagePush", () => {
  it("sends one data-only retraction per recipient, keyed on the message", async () => {
    redisMock.smembers.mockResolvedValue(["u1", "u2"]);

    await retractMessagePush("m1", "grp_1");

    expect(push).toHaveBeenCalledTimes(2);
    const first = push.mock.calls[0][0];
    expect(first).toMatchObject({
      userId: "u1",
      type: "MESSAGE_DELETED",
      dataOnly: true,
      skipInbox: true,
      bypassSettings: true,
      collapseKey: "del:m1",
      // Must outlive a closed browser, like the card it retracts.
      ttl: 86_400,
      data: {
        type: "MESSAGE_DELETED",
        messageId: "m1",
        conversationId: "grp_1",
      },
    });
    expect(push.mock.calls[1][0].userId).toBe("u2");
  });

  it("claims the recipient set, so a replayed delete retracts exactly once", async () => {
    redisMock.smembers
      .mockResolvedValueOnce(["u1"])
      .mockResolvedValueOnce([] as string[]);

    await retractMessagePush("m1", "grp_1");
    await retractMessagePush("m1", "grp_1");

    expect(redisMock.del).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nobody was pushed for that message", async () => {
    await retractMessagePush("never-pushed", "grp_1");

    expect(push).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("stays silent when Redis is unavailable", async () => {
    redisMock.smembers.mockRejectedValue(new Error("redis down"));

    await expect(retractMessagePush("m1", "grp_1")).resolves.toBeUndefined();
    expect(push).not.toHaveBeenCalled();
  });

  it("survives a failed retraction push", async () => {
    redisMock.smembers.mockResolvedValue(["u1", "u2"]);
    push.mockRejectedValueOnce(new Error("no tokens"));

    await expect(retractMessagePush("m1", "grp_1")).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledTimes(2);
  });
});
