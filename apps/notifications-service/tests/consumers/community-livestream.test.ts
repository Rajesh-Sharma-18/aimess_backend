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
 *   - started: navigation COMMUNITY_LIVESTREAM carries the livestreamId; ended
 *     routes to the community chat and shares the started card's per-stream tag
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

jest.mock("../../src/services/push-dismiss.js", () => ({
  dismissTrayCards: jest.fn(async () => undefined),
}));

jest.mock("../../src/lib/live-streams.js", () => ({
  trackLiveStream: jest.fn(async () => undefined),
  liveStreamTags: jest.fn(async () => ["live:s-old", "live:s-now"]),
}));

import { CommunityEvents } from "@aimess/shared-types";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { redis } from "../../src/config/redis.js";
import { trackLiveStream } from "../../src/lib/live-streams.js";
import { dismissTrayCards } from "../../src/services/push-dismiss.js";
import { pushToUser, pushToUsers } from "../../src/services/push.service.js";

const pushMany = pushToUsers as jest.Mock;
const pushOne = pushToUser as jest.Mock;
const dismiss = dismissTrayCards as jest.Mock;
const redisGet = redis.get as jest.Mock;
const redisSet = redis.set as jest.Mock;

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
  pushOne.mockClear();
  dismiss.mockClear();
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockClear();
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

  it("tags the card per stream session, so only its own end replaces it", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);
    const input = pushMany.mock.calls[0][1](U1);
    expect(input.collapseKey).toBe(`live:${SID}`);
    expect(input.data.idempotencyKey).toBe(`live:${SID}:started`);
  });

  it("a start delivered after its stream already ended draws nothing", async () => {
    redisGet.mockResolvedValueOnce("1");
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);
    expect(redisGet).toHaveBeenCalledWith(`notif:livestream:ended:${SID}`);
    expect(pushMany).not.toHaveBeenCalled();
  });

  it("does not push when the recipient list is empty", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, {
      ...startedPayload,
      recipientIds: [],
    });
    expect(pushMany).not.toHaveBeenCalled();
  });
});


const endedInputs = () =>
  pushOne.mock.calls
    .map((c) => c[0])
    .filter((i) => i.type === CommunityEvents.LIVESTREAM_ENDED);
const endedRecipients = () => endedInputs().map((i) => i.userId);
const endedFor = (userId: string) => endedInputs().find((i) => i.userId === userId);

describe("LIVESTREAM_ENDED branch", () => {
  it("replaces the started card in place and no longer routes to the stream", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      duration: "1m",
      durationSeconds: 60,
    });
    const input = endedFor(U1);
    // Silent: an inbox rewrite only, through every gate, never a tray card.
    expect(input).toMatchObject({ skipPush: true, bypassSettings: true });
    expect(input.collapseKey).toBeUndefined();
    expect(input.data).toMatchObject({
      livestreamId: SID,
      resurface: "false",
      updateOnly: "true",
    });
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ userId: U1, tags: [`live:${SID}`] })
    );
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ userId: U2, tags: [`live:${SID}`] })
    );
    const nav = JSON.parse(input.data.navigation);
    expect(nav.screen).toBe("COMMUNITY_CHAT");
    expect(nav.livestreamId).toBeUndefined();
    expect(redisSet).toHaveBeenCalledWith(
      `notif:livestream:ended:${SID}`,
      "1",
      "EX",
      86_400
    );
    // The host ended it and never had a live card: nothing to retract.
    expect(pushOne.mock.calls.map((c) => c[0].type)).not.toContain(
      "community.livestream_retracted"
    );
  });

  it("community admin's own live card is retracted, never rewritten into an ended card", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      recipientIds: [HOST, U2],
      duration: "2m",
      durationSeconds: 120,
      endedReason: "USER",
      endedByUserId: U1,
      endedByDisplayName: "Admin Person",
    });
    expect(pushOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: U1,
        type: "community.livestream_retracted",
        skipPush: true,
        data: expect.objectContaining({ groupKey: `livestream:${SID}` }),
      })
    );
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ userId: U1, tags: [`live:${SID}`] })
    );
    expect(endedRecipients()).toEqual([HOST, U2]);
  });

  it("fans out an 'ended the livestream' push with the duration", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      duration: "1h 24m",
      durationSeconds: 5040,
    });

        const recipients = endedRecipients();
    const build = endedFor;
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

        const recipients = endedRecipients();
    const build = endedFor;
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

        const recipients = endedRecipients();
    const build = endedFor;
    expect(recipients).toEqual([U2]);
    const body = build(U2).copy("en").body;
    expect(body).toBe("Admin Person ended Jane Doe's livestream in Cool Community after 2m");
    expect(build(U2).copy("vi").body).toBe(
      "Admin Person đã kết thúc buổi phát trực tiếp của Jane Doe trong Cool Community sau 2m"
    );
  });

  it("host's own End Live never pushes the host", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      recipientIds: [HOST, U1],
      duration: "4m",
      durationSeconds: 240,
      endedReason: "USER",
    });

    const recipients = endedRecipients();
    const build = endedFor;
    expect(recipients).toEqual([U1]);
    expect(build(U1).copy("en").body).toBe(
      "Jane Doe ended the livestream in Cool Community after 4m"
    );
    expect(build(U1).actorId).toBe(HOST);
  });

  it("community admin End for Everyone pushes the HOST, naming the admin", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      recipientIds: [HOST, U1, U2],
      duration: "4m",
      durationSeconds: 240,
      endedReason: "USER",
      endedByUserId: U1,
      endedByDisplayName: "Admin Person",
    });

    const recipients = endedRecipients();
    const build = endedFor;
    expect(recipients).toEqual([HOST, U2]);
    expect(build(HOST).copy("en").body).toBe(
      "Admin Person ended Jane Doe's livestream in Cool Community after 4m"
    );
    // push.service drops recipient === actorId: the actor must be the admin,
    // or the host's push is silently suppressed.
    expect(build(HOST).actorId).toBe(U1);
    expect(JSON.parse(build(HOST).data.actorSnapshot).userId).toBe(U1);
    expect(build(HOST).data.hostUserId).toBe(HOST);
  });

  it("Super Admin end (ADMIN) reads 'Administrator ended {host}'s livestream', pushes the host, leaks no identity", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      recipientIds: [HOST, U1, U2],
      duration: "4m",
      durationSeconds: 240,
      endedReason: "ADMIN",
    });

        const recipients = endedRecipients();
    const build = endedFor;
    expect(recipients).toEqual([HOST, U1, U2]);
    // The host reads the host-less form; everyone else is told whose it was.
    expect(build(HOST).copy("en").body).toBe(
      "Administrator ended the livestream in Cool Community after 4m"
    );
    expect(build(HOST).copy.descriptor.args).not.toContain("Jane Doe");
    const input = build(U1);
    expect(input.copy("en").body).toBe(
      "Administrator ended Jane Doe's livestream in Cool Community after 4m"
    );
    expect(input.copy("vi").body).toBe(
      "Quản trị viên đã kết thúc buổi phát trực tiếp của Jane Doe trong Cool Community sau 4m"
    );
    expect(input.copy("th").body).toBe(
      "ผู้ดูแลระบบจบไลฟ์สตรีมของJane DoeในCool Communityหลังจาก 4m"
    );
    for (const locale of ["en", "vi", "th"]) {
      expect(input.copy(locale).body).not.toMatch(/System|Hệ thống|An administrator/);
    }
    expect(input.copy.descriptor.ref).toBe("community.livestreamEndedByAdmin");
    expect(input.actorId).toBeUndefined();
    expect(input.data).toMatchObject({ endedReason: "ADMIN", hostUserId: HOST });
    expect(JSON.stringify(input.data)).not.toMatch(/endedBy(UserId|DisplayName)/);
  });

  it("the host gets a row only when someone else ended their stream", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...startedPayload,
      recipientIds: [HOST, U1],
      duration: "4m",
      durationSeconds: 240,
      endedReason: "ADMIN",
    });
    expect(endedFor(HOST)?.data.updateOnly).toBeUndefined();
    expect(endedFor(U1)?.data.updateOnly).toBe("true");
  });
});

describe("per-stream live cards close with the community", () => {
  it("a start is tracked so the community's own dismissals can find its card", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);
    expect(trackLiveStream).toHaveBeenCalledWith(CID, SID);
  });

  it("closing the community takes back its live cards, not its chat cards", async () => {
    await deliver(CommunityEvents.CLOSED, {
      communityId: CID,
      memberIds: [U1],
      actorId: HOST,
    });
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ userId: U1, tags: ["live:s-old", "live:s-now"] })
    );
  });

  it("a removed member loses the community's live cards with its room cards", async () => {
    await deliver(CommunityEvents.MEMBER_KICKED, {
      communityId: CID,
      targetUserId: U1,
      actorId: HOST,
    });
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: U1,
        tags: expect.arrayContaining([`conv:${CID}`, "live:s-old", "live:s-now"]),
      })
    );
  });
});
