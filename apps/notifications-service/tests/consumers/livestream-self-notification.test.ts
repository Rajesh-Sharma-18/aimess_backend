/**
 * The livestream HOST is never a recipient of their own announcement.
 *
 * `community.livestream_started` / `community.livestream_ended` carry a
 * pre-resolved `recipientIds` roster. community-service already drops the host
 * from it, but the self-exclusion is a property of the EVENT, not of one
 * producer: this consumer is the last authority before an inbox row, a
 * `notification:new` frame and an FCM/APNs push exist, so it enforces the rule
 * again here. These tests therefore feed payloads whose roster DOES contain the
 * host — the shape an older producer, a replay, or a future group-livestream
 * source could emit — and assert that nothing at all is created for them while
 * every other eligible member is untouched.
 *
 * Same seam as community-consumer.test.ts: amqplib is faked so the captured
 * `channel.consume` callback can be fed `{ type, data }` envelopes, and
 * push.service is mocked because it IS the inbox + realtime + push boundary
 * (`pushToUser` writes the Notification-Center row through chat-service, which
 * emits `notification:new` / `notification:count_update`, and fans out to every
 * device token of that userId).
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

jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { getCommunityBrief: jest.fn(async () => null) },
}));

import { CommunityEvents } from "@aimess/shared-types";
import { DEFAULT_LOCALE, type SupportedLocale } from "@aimess/constants";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { pushToUser, pushToUsers } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;
const pushMany = pushToUsers as jest.Mock;

const CID = "c".repeat(24);
const SID = "5".repeat(24);
/**
 * Canonical AIMess userIds. The host's is the ONLY identity the exclusion may
 * key on — the payload deliberately also carries a display name that collides
 * with nobody, so a test passing on name comparison would be a false pass.
 */
const HOST = "44444444-4444-4444-8444-444444444444";
const MEMBER_A = "55555555-5555-4555-8555-555555555555";
const MEMBER_B = "66666666-6666-4666-8666-666666666666";

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

/** Every userId this event produced a notification for. */
function fannedOutTo(): string[] {
  const fromMany = pushMany.mock.calls.flatMap(
    (call) => call[0] as unknown as string[]
  );
  const fromSingle = push.mock.calls.map(
    (call) => (call[0] as { userId: string }).userId
  );
  return [...fromMany, ...fromSingle];
}

/** The PushInput one recipient would receive (what pushToUsers builds per user). */
function inputFor(userId: string): Record<string, unknown> {
  const call = pushMany.mock.calls.find((c) =>
    (c[0] as unknown as string[]).includes(userId)
  );
  if (!call) throw new Error(`no fan-out containing ${userId}`);
  const build = call[1] as (id: string) => Record<string, unknown>;
  return build(userId);
}

const startedPayload = {
  communityId: CID,
  communityName: "Mission AIMESS",
  communityHandle: "mission",
  communityAvatarUrl: null,
  eventAt: "2026-09-24T10:00:00.000Z",
  livestreamId: SID,
  hostUserId: HOST,
  hostDisplayName: "Host Person",
  hostAvatarUrl: null,
  // The broken roster: the host is in their own recipient list.
  recipientIds: [HOST, MEMBER_A, MEMBER_B],
};

const endedPayload = {
  ...startedPayload,
  duration: "1h 24m",
  durationSeconds: 5040,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("LIVESTREAM_STARTED", () => {
  it("never notifies the host, whatever the payload's roster says", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    expect(fannedOutTo()).not.toContain(HOST);
  });

  it("still notifies every other eligible member", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    expect(fannedOutTo().sort()).toEqual([MEMBER_A, MEMBER_B].sort());
  });

  it("fans out exactly once — no duplicate notification per member", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    expect(pushMany).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    const recipients = fannedOutTo();
    expect(recipients).toHaveLength(new Set(recipients).size);
  });

  it("keeps the LIVE_NOW gating + navigation intact for a real recipient", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    const input = inputFor(MEMBER_A);
    expect(input.type).toBe(CommunityEvents.LIVESTREAM_STARTED);
    // Category drives BOTH the per-user livestream toggle and the community's
    // own streamEnabled preference (push.service defaultCommunityPrefField).
    expect(input.category).toBe("liveStreamEnabled");
    expect(input.actorId).toBe(HOST);
    const navigation = JSON.parse(
      (input.data as Record<string, string>).navigation
    ) as Record<string, string>;
    expect(navigation.screen).toBe("COMMUNITY_LIVESTREAM");
    expect(navigation.livestreamId).toBe(SID);
  });

  it("renders each recipient's copy in THEIR language, not the host's", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, startedPayload);

    const copy = inputFor(MEMBER_A).copy as (
      locale: SupportedLocale
    ) => { title: string; body: string };
    const en = copy("en" as SupportedLocale);
    const th = copy("th" as SupportedLocale);
    const vi = copy("vi" as SupportedLocale);
    expect(en.body).toContain("Host Person");
    expect(th.body).toContain("Host Person");
    expect(vi.body).toContain("Host Person");
    // A real per-locale render, not one string reused everywhere.
    expect(th.body).not.toBe(en.body);
    expect(vi.body).not.toBe(en.body);
    expect(copy(DEFAULT_LOCALE).body.length).toBeGreaterThan(0);
  });

  it("creates nothing at all when the host is the only candidate", async () => {
    await deliver(CommunityEvents.LIVESTREAM_STARTED, {
      ...startedPayload,
      recipientIds: [HOST],
    });

    expect(pushMany).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("excludes the host once per payload, not once per device or session", async () => {
    // The same account signed in five times is still ONE canonical userId; a
    // roster that repeats it (one entry per session) must collapse to nothing.
    await deliver(CommunityEvents.LIVESTREAM_STARTED, {
      ...startedPayload,
      recipientIds: [HOST, HOST, HOST, MEMBER_A],
    });

    expect(fannedOutTo()).toEqual([MEMBER_A]);
  });
});

describe("LIVESTREAM_ENDED", () => {
  it("never notifies the host, whatever the payload's roster says", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, endedPayload);

    expect(fannedOutTo()).not.toContain(HOST);
  });

  it("still notifies every other eligible member, with the duration", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, endedPayload);

    expect(fannedOutTo().sort()).toEqual([MEMBER_A, MEMBER_B].sort());
    const input = inputFor(MEMBER_B);
    expect(input.category).toBe("liveStreamEnabled");
    expect((input.data as Record<string, string>).duration).toBe("1h 24m");
    expect((input.data as Record<string, string>).durationSeconds).toBe("5040");
  });

  it("fans out exactly once — no duplicate notification per member", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, endedPayload);

    expect(pushMany).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("creates nothing at all when the host is the only candidate", async () => {
    await deliver(CommunityEvents.LIVESTREAM_ENDED, {
      ...endedPayload,
      recipientIds: [HOST],
    });

    expect(pushMany).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
