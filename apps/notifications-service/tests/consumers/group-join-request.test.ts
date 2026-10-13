/**
 * Private-group join requests: admin actionable card (+ supersede retraction),
 * retraction on settle, requester outcome cards.
 */
const channelMock = {
  assertQueue: jest.fn(),
  prefetch: jest.fn(),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(async () => ({ createChannel: async () => channelMock })),
  },
}));
const calls: Array<{ userId: string; [k: string]: unknown }> = [];
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async (input: { userId: string }) => {
    calls.push(input);
  }),
  pushToUsers: jest.fn(
    async (ids: string[], build: (id: string) => { userId: string }) => {
      for (const id of ids) calls.push(build(id));
    }
  ),
}));

import { ChatEvents } from "@aimess/shared-types";

import { startGroupConsumer } from "../../src/consumers/group.consumer.js";
import { userIdentityClient } from "../../src/grpc/user-identity.client.js";

const getDisplayName = userIdentityClient.getDisplayName as jest.Mock;

async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startGroupConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (m: {
    content: Buffer;
  }) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  calls.length = 0;
  getDisplayName.mockReset();
  getDisplayName.mockResolvedValue("Jane Doe");
});

it("GROUP_JOIN_REQUESTED: retracts the previous card, then one actionable card per ADMIN", async () => {
  await deliver(ChatEvents.GROUP_JOIN_REQUESTED, {
    roomId: "room-1",
    groupName: "Devs",
    requestId: "req-1",
    requesterId: "u-jane",
    adminRecipientIds: ["u-admin", "u-jane"],
    eventAt: "2026-10-12T10:00:00.000Z",
  });

  const retract = calls.filter((c) => c.type === ChatEvents.GROUP_JOIN_REQUEST_RETRACTED);
  const cards = calls.filter((c) => c.type === ChatEvents.GROUP_JOIN_REQUESTED);
  expect(retract.map((c) => c.userId)).toEqual(["u-admin"]);
  expect(cards.map((c) => c.userId)).toEqual(["u-admin"]);
  const card = cards[0] as Record<string, any>;
  expect(card.apnsCategory).toBe("GROUP_JOIN_REQUEST");
  expect(card.actions("en").map((a: { action: string }) => a.action)).toEqual([
    "group_join_request_accept",
    "group_join_request_reject",
  ]);
  expect(card.data).toMatchObject({
    groupKey: "group:room-1:join_request:u-jane",
    requestId: "req-1",
    requesterId: "u-jane",
  });
  expect(JSON.parse(card.data.navigation)).toMatchObject({ screen: "GROUP_REQUESTS", roomId: "room-1" });
  expect(card.copy("en").body).toBe("Jane Doe asked to join Devs");
});

it("GROUP_JOIN_REQUEST_RETRACTED: data-only delete to every admin", async () => {
  await deliver(ChatEvents.GROUP_JOIN_REQUEST_RETRACTED, {
    roomId: "room-1",
    requestId: "req-1",
    requesterId: "u-jane",
    adminRecipientIds: ["u-a1", "u-a2"],
    resolution: "APPROVED",
    eventAt: "2026-10-12T10:00:00.000Z",
  });
  expect(calls.map((c) => c.userId)).toEqual(["u-a1", "u-a2"]);
  expect(calls[0]).toMatchObject({
    dataOnly: true,
    bypassSettings: true,
    data: expect.objectContaining({
      groupKey: "group:room-1:join_request:u-jane",
      staleBefore: "2026-10-12T10:00:00.000Z",
    }),
  });
});

it.each([
  [ChatEvents.GROUP_JOIN_REQUEST_APPROVED, "Your request to join Devs was approved", "GROUP_CHAT"],
  [ChatEvents.GROUP_JOIN_REQUEST_REJECTED, "Your request to join Devs wasn’t approved", "NOTIFICATIONS"],
])("%s → requester only", async (type, body, screen) => {
  await deliver(type, {
    roomId: "room-1",
    groupName: "Devs",
    requestId: "req-1",
    requesterId: "u-jane",
    decidedBy: "u-admin",
    eventAt: "2026-10-12T10:00:00.000Z",
  });
  expect(calls).toHaveLength(1);
  const c = calls[0] as Record<string, any>;
  expect(c.userId).toBe("u-jane");
  expect(c.copy("en").body).toBe(body);
  expect(JSON.parse(c.data.navigation).screen).toBe(screen);
});
