/**
 * Delete-for-me vs delete-for-everyone in the notification lifecycle.
 *
 * Both scopes publish the SAME tombstone event (`message:delete` /
 * `community:message:deleted`) — only the scope field differs. Acting on the
 * event without reading that field made one user hiding their own copy cancel
 * every other recipient's pending push, and (once retraction existed) would
 * have pulled the tray card off their devices too.
 *
 * These pin both halves: a for-me tombstone changes nothing for anyone else, a
 * for-everyone tombstone both cancels what is still queued and retracts what has
 * already been delivered.
 */
const sub = {
  status: "ready",
  connect: jest.fn(async () => undefined),
  psubscribe: jest.fn(async () => undefined),
  on: jest.fn(),
};

jest.mock("../../src/config/redis.js", () => ({
  redis: { duplicate: () => sub },
}));
jest.mock("../../src/services/chat-push-coalescer.js", () => ({
  dropPendingChatMessage: jest.fn(),
  updatePendingChatMessage: jest.fn(),
}));
jest.mock("../../src/services/push-retraction.js", () => ({
  retractMessagePush: jest.fn(async () => undefined),
}));

import { dropPendingChatMessage } from "../../src/services/chat-push-coalescer.js";
import { retractMessagePush } from "../../src/services/push-retraction.js";
import { startPendingPushSync } from "../../src/consumers/pending-push-sync.js";

const drop = dropPendingChatMessage as unknown as jest.Mock;
const retract = retractMessagePush as unknown as jest.Mock;

startPendingPushSync();
const onFrame = sub.on.mock.calls.find((c) => c[0] === "pmessage")![1] as (
  pattern: string,
  channel: string,
  raw: string
) => void;

const deliver = (event: string, data: Record<string, unknown>) =>
  onFrame("conv:*", "conv:room", JSON.stringify({ event, data }));

beforeEach(() => {
  drop.mockClear();
  retract.mockClear();
});

describe("delete for everyone", () => {
  it("cancels the queued push and retracts the delivered one (PRIVATE/GROUP)", () => {
    deliver("message:delete", {
      messageId: "m1",
      conversationId: "prv_1",
      type: "forEveryone",
      deletedForEveryone: true,
    });

    expect(drop).toHaveBeenCalledWith("m1");
    expect(retract).toHaveBeenCalledWith("m1", "prv_1");
  });

  it("does the same for a COMMUNITY tombstone", () => {
    deliver("community:message:deleted", {
      messageId: "c1",
      communityId: "com_1",
      roomId: "com_1",
      deleteType: "forEveryone",
      deletedForEveryone: true,
    });

    expect(drop).toHaveBeenCalledWith("c1");
    expect(retract).toHaveBeenCalledWith("c1", "com_1");
  });

  it("is idempotent at this layer — a redelivered tombstone repeats the same calls", () => {
    const frame = {
      messageId: "m1",
      conversationId: "grp_1",
      type: "forEveryone",
      deletedForEveryone: true,
    };
    deliver("message:delete", frame);
    deliver("message:delete", frame);

    expect(drop.mock.calls).toEqual([["m1"], ["m1"]]);
    expect(retract.mock.calls).toEqual([
      ["m1", "grp_1"],
      ["m1", "grp_1"],
    ]);
  });
});

describe("delete for me", () => {
  it("touches nothing for a PRIVATE/GROUP tombstone", () => {
    deliver("message:delete", {
      messageId: "m2",
      conversationId: "prv_1",
      type: "forMe",
      deletedForEveryone: false,
    });

    expect(drop).not.toHaveBeenCalled();
    expect(retract).not.toHaveBeenCalled();
  });

  it("touches nothing for a COMMUNITY tombstone", () => {
    deliver("community:message:deleted", {
      messageId: "c2",
      communityId: "com_1",
      deleteType: "forMe",
      deletedForEveryone: false,
    });

    expect(drop).not.toHaveBeenCalled();
    expect(retract).not.toHaveBeenCalled();
  });

  it("is recognised from `deletedForEveryone` alone", () => {
    deliver("message:delete", {
      messageId: "m3",
      conversationId: "prv_1",
      deletedForEveryone: false,
    });

    expect(drop).not.toHaveBeenCalled();
    expect(retract).not.toHaveBeenCalled();
  });
});
