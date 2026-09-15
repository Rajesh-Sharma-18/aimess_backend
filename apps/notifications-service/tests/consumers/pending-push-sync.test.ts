/**
 * pending-push-sync against the real `message:edited` frame chat-service
 * publishes (buildChatMessageEvent: `id`, `conversationType`, full `content`).
 * A GROUP frame re-states who is still mentioned so the coalescer can drop a
 * pending mention the edit removed; every other frame keeps the text update.
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

import { updatePendingChatMessage } from "../../src/services/chat-push-coalescer.js";
import { startPendingPushSync } from "../../src/consumers/pending-push-sync.js";

const update = updatePendingChatMessage as unknown as jest.Mock;

startPendingPushSync();
const onFrame = sub.on.mock.calls.find((c) => c[0] === "pmessage")![1] as (
  pattern: string,
  channel: string,
  raw: string
) => void;

const deliver = (event: string, data: Record<string, unknown>) =>
  onFrame("conv:*", "conv:room", JSON.stringify({ event, data }));

beforeEach(() => {
  update.mockClear();
});

describe("pending-push-sync message:edited", () => {
  it("a GROUP frame passes the still-mentioned userIds", () => {
    deliver("message:edited", {
      id: "m1",
      roomId: "grp_1",
      conversationType: "GROUP",
      content: {
        text: "hi @bo",
        urls: [],
        mentions: [{ userId: "bo-id", username: "bo", offset: 3, length: 3 }],
      },
    });

    expect(update.mock.calls).toEqual([["m1", "hi @bo", new Set(["bo-id"])]]);
  });

  it("a GROUP frame with no mentions array means nobody, even with empty text", () => {
    deliver("message:edited", {
      id: "m1",
      roomId: "grp_1",
      conversationType: "GROUP",
      content: { text: "", urls: [] },
    });

    expect(update.mock.calls).toEqual([["m1", "", new Set()]]);
  });

  it("a PRIVATE frame keeps the text-only update and skips empty text", () => {
    deliver("message:edited", {
      id: "p1",
      roomId: "prv_1",
      conversationType: "PRIVATE",
      content: { text: "fixed" },
    });
    deliver("message:edited", {
      id: "p2",
      roomId: "prv_1",
      conversationType: "PRIVATE",
      content: { text: "" },
    });

    expect(update.mock.calls).toEqual([["p1", "fixed"]]);
  });

  it("community:message:edited is unchanged", () => {
    deliver("community:message:edited", { messageId: "c1", message: "new" });

    expect(update.mock.calls).toEqual([["c1", "new"]]);
  });
});
