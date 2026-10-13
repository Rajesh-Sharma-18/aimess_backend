const sendToQueue = jest.fn();
jest.mock("amqplib", () => ({
  connect: jest.fn(async () => ({
    on: jest.fn(),
    createChannel: async () => ({ assertQueue: jest.fn(), sendToQueue }),
  })),
}));

import { publishAdminActiveSafe } from "../../src/events/publish-community-activity.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("publishAdminActiveSafe", () => {
  it("publishes an admin_active activity at most once per hour per admin per community", async () => {
    publishAdminActiveSafe("c1", "a1");
    publishAdminActiveSafe("c1", "a1");
    publishAdminActiveSafe("c2", "a1");
    await flush();
    await flush();

    expect(sendToQueue).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(sendToQueue.mock.calls[0][1]));
    expect(body).toMatchObject({
      type: "community.activity",
      data: { communityId: "c1", type: "admin_active", senderUserId: "a1" },
    });
  });
});
