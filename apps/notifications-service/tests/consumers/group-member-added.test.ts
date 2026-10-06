/**
 * Group Add Member push: names the actual actor and the added member, and the
 * added member reads their own side as "You". user-identity is globally mocked
 * (tests/setup/global-mocks.ts); push.service is mocked here to capture copy.
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
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
}));

import { ChatEvents } from "@aimess/shared-types";

import { startGroupConsumer } from "../../src/consumers/group.consumer.js";
import { userIdentityClient } from "../../src/grpc/user-identity.client.js";
import { pushToUser } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;
const getDisplayName = userIdentityClient.getDisplayName as jest.Mock;
const KRISTI = "u-kristi";
const BOYD = "u-boyd";

async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startGroupConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (m: {
    content: Buffer;
  }) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  push.mockClear();
  getDisplayName.mockReset();
});

it("pushes '{actor} added You to {group}' to the added member", async () => {
  getDisplayName.mockImplementation(
    async (id: string) =>
      ({ [KRISTI]: "Kristi Noem", [BOYD]: "Boyd Stevens" })[id] ?? null
  );
  await deliver(ChatEvents.GROUP_MEMBER_ADDED, {
    roomId: "room-1",
    groupName: "Weekend Trip",
    addedUserId: BOYD,
    actorId: KRISTI,
    eventAt: "2026-10-05T10:00:00.000Z",
  });

  expect(push).toHaveBeenCalledTimes(1);
  const arg = push.mock.calls[0][0];
  expect(arg.userId).toBe(BOYD);
  expect(arg.actorId).toBe(KRISTI);
  expect(arg.copy("en", BOYD)).toMatchObject({
    title: "Weekend Trip",
    body: "Kristi Noem added You to Weekend Trip",
  });
  expect(arg.copy.descriptor).toEqual({
    ref: "group.memberAdded",
    args: ["Weekend Trip", "Kristi Noem", "Boyd Stevens", KRISTI, BOYD],
  });
});

it("an unresolvable actor name falls back to 'Someone', never undefined", async () => {
  getDisplayName.mockResolvedValue(null);
  await deliver(ChatEvents.GROUP_MEMBER_ADDED, {
    roomId: "room-1",
    groupName: "Weekend Trip",
    addedUserId: BOYD,
    actorId: KRISTI,
    eventAt: "2026-10-05T10:00:00.000Z",
  });
  expect(push.mock.calls[0][0].copy("en", BOYD).body).toBe(
    "Someone added You to Weekend Trip"
  );
});
