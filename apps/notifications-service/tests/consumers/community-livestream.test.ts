/**
 * notifications-service `community.consumer.ts` LIVESTREAM_STARTED /
 * LIVESTREAM_ENDED branches.
 *
 * `handleCommunityEvent` is module-internal, so we drive it through the real
 * public seam: `startCommunityConsumer()` wires a `channel.consume` callback,
 * which we capture (amqplib faked) and feed `{ type, data }` envelopes. We assert
 * on the mocked push.service (`pushToUsers`).
 *
 * Verifies:
 *   - host-named copy ("{host} is live in {community}" / "ended … after 1h 24m")
 *   - title = community name; category = liveStreamEnabled (dedicated toggle)
 *   - navigation screen COMMUNITY_LIVESTREAM carries the livestreamId
 *   - empty recipient list → no push
 */

const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
const connectionMock = {
  createChannel: jest.fn(async () => channelMock),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => connectionMock) },
  connect: jest.fn(async () => connectionMock),
}));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));

jest.mock("@aimess/redis", () => ({
  publishUserSocketEvent: jest.fn(async () => 1),
}));

import { CommunityEvents } from "@aimess/shared-types";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";

const pushMany = pushToUsers as jest.Mock;

const CID = "c".repeat(24);
const SID = "5".repeat(24);
const HOST = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";

async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startCommunityConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (
    msg: { content: Buffer } | null
  ) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  pushMany.mockClear();
});

const startedPayload = {
  communityId: CID,
  eventAt: "2026-06-29T10:00:00.000Z",
  livestreamId: SID,
  hostUserId: HOST,
  hostDisplayName: "Jane Doe",
  hostAvatarUrl: null,
  communityName: "Cool Community",
  communityHandle: "cool",
  communityAvatarUrl: null,
  recipientIds: [U1, U2],
};

describe("LIVESTREAM_STARTED branch", () => {
  it("fans out a host-named push to recipients on the liveStreamEnabled category", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0];
    expect(recipients).toEqual([U1, U2]);

    const input = build(U1);
    expect(input.userId).toBe(U1);
    expect(input.copy("en").title).toBe("Cool Community");
    expect(input.copy("en").body).toBe("Jane Doe is live in Cool Community");
    expect(input.category).toBe("liveStreamEnabled");
    expect(input.type).toBe(CommunityEvents.LIVESTREAM_STARTED);
    expect(input.data).toMatchObject({
      livestreamId: SID,
      hostUserId: HOST,
      communityId: CID,
    });
    const nav = JSON.parse(input.data.navigation);
    expect(nav).toMatchObject({
      screen: "COMMUNITY_LIVESTREAM",
      livestreamId: SID,
      communityId: CID,
    });
  });

  it("does not push when the recipient list is empty", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, {
      ...startedPayload,
      recipientIds: [],
    });
    expect(pushMany).not.toHaveBeenCalled();
  });
});

describe("LIVESTREAM_ENDED branch", () => {
  it("fans out an 'ended the livestream' push with the duration", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      duration: "1h 24m",
      durationSeconds: 5040,
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0];
    expect(recipients).toEqual([U1, U2]);

    const input = build(U2);
    expect(input.copy("en").body).toBe(
      "Jane Doe ended the livestream in Cool Community after 1h 24m"
    );
    expect(input.category).toBe("liveStreamEnabled");
    expect(input.type).toBe(CommunityEvents.LIVESTREAM_ENDED);
    expect(input.data).toMatchObject({
      duration: "1h 24m",
      durationSeconds: "5040",
      livestreamId: SID,
    });
  });

  it("platform end (endedReason SYSTEM) says 'System ended…', never the host, in each locale", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      duration: "36m",
      durationSeconds: 2160,
      endedReason: "SYSTEM",
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0];
    // Host still excluded — no self-notification.
    expect(recipients).toEqual([U1, U2]);
    const input = build(U1);
    expect(input.copy("en").body).toBe(
      "System ended the livestream in Cool Community after 36m"
    );
    expect(input.copy("vi").body).toContain("Hệ thống");
    expect(input.copy("th").body).toContain("ระบบ");
    for (const locale of ["en", "vi", "th"]) {
      expect(input.copy(locale).body).not.toContain("Jane Doe");
    }
    expect(input.copy.descriptor.ref).toBe("community.livestreamEndedBySystem");
    expect(input.data).toMatchObject({ endedReason: "SYSTEM", hostUserId: HOST });
  });

  it("community admin End for Everyone names the admin and skips the admin's own push", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      duration: "2m",
      durationSeconds: 120,
      endedReason: "USER",
      endedByUserId: U1,
      endedByDisplayName: "Admin Person",
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0];
    expect(recipients).toEqual([U2]);
    const body = build(U2).copy("en").body;
    expect(body).toBe("Admin Person ended the livestream in Cool Community after 2m");
    expect(body).not.toContain("Jane Doe");
  });
});
