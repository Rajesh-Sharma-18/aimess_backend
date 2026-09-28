/**
 * ONE Super Admin announcement must move a recipient's unread badge by ONE.
 *
 * The reported failure: unread count 0, one announcement sent, badge 2. It was
 * never a duplicate — the DB holds exactly one row per recipient per
 * announcement — it was the count on the wire. A freshly-logged-in session has
 * an unread "Login Detected" row that its own list, per-tab counts and
 * `/unread-count` all withhold from it, so its badge reads 0 while the account
 * holds 1. The announcement's `notification:new` then carried the ACCOUNT-wide
 * number with nothing to resolve it by, and that device jumped 0 -> 2. Reading
 * or reloading re-read the session-scoped count, which is why the next
 * announcement appeared to behave.
 *
 * These cases pin the write and the wire for the announcement path specifically:
 * one row, one `notification:new`, one `notification:count_update`, both frames
 * carrying the account count AND `selfHiddenSessions` so the gateway resolves
 * the badge per device — and the resolved number rising by exactly one.
 *
 * `unreadCountForSession` here is the same function the gateway applies per
 * socket (`api-gateway/src/sockets/unread-count-scope.ts` is its twin, covered
 * by `notification-unread-scope.test.ts`); using it is what makes these
 * assertions about the BADGE rather than about a payload field.
 */
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  publishMentionRetractedSafe: jest.fn(),
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));

import {
  createNotificationImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import {
  unreadCountForSession,
  type UnreadFanout,
} from "../../src/repositories/notification.repository.js";
import { redis } from "../../src/config/redis.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

const RECIPIENT = "u_recipient";
/** The device that just signed in — the one its own login alert is hidden from. */
const FRESH_SESSION = "s_just_logged_in";
/** Another device of the same account, which SEES that login alert. */
const OTHER_SESSION = "s_phone";

const publishMock = redis.publish as unknown as jest.Mock;

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Every `{event, data}` envelope published to this user's notify channel. */
const frames = (): Frame[] =>
  publishMock.mock.calls
    .filter(([channel]: [string]) => channel === `notify:${RECIPIENT}`)
    .map(([, body]: [string, string]) => JSON.parse(body) as Frame);

/**
 * `createNotification` wired to a repository whose unread fanout is whatever the
 * account actually holds at that moment. `fanout` is mutable so a test can send
 * two announcements and have the second one see the first one's row.
 */
function setup(fanout: UnreadFanout) {
  const created: Record<string, unknown>[] = [];
  const notificationRepo = {
    create: jest.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return {
        id: `notif-${created.length}`,
        createdAt: new Date("2026-09-28T10:00:00Z"),
        updatedAt: new Date("2026-09-28T10:00:00Z"),
        loginExpiresAt: null,
        ...input,
      };
    }),
    getUnreadFanout: jest.fn(async () => fanout),
    getUnreadCount: jest.fn(async () => fanout.unreadCount),
    findActiveByGroupKey: jest.fn(async () => null),
  };
  const deps = { notificationRepo } as unknown as GrpcDeps;
  const handler = createNotificationImpl(deps).createNotification as Handler;

  const sendAnnouncement = (announcementId: string, title: string) =>
    new Promise<{ id: string }>((resolve, reject) =>
      handler(
        {
          request: {
            userId: RECIPIENT,
            actorId: "",
            type: "ANNOUNCEMENT",
            title,
            body: `body of ${announcementId}`,
            // Exactly what notifications-service' announcement consumer sends
            // (push.service.ts -> chatNotificationClient.createNotification).
            data: {
              type: "ANNOUNCEMENT",
              announcementId,
              navigation: JSON.stringify({ screen: "NOTIFICATIONS" }),
            },
          },
        },
        (err, res) =>
          err ? reject(err as Error) : resolve(res as { id: string })
      )
    );

  return { notificationRepo, created, sendAnnouncement };
}

beforeEach(() => {
  publishMock.mockClear();
});

describe("one announcement, one recipient row, one event", () => {
  it("writes exactly one row and publishes exactly one notification:new", async () => {
    const { created, sendAnnouncement } = setup({
      unreadCount: 1,
      selfHiddenSessions: [],
    });

    const res = await sendAnnouncement("ann-A", "Scheduled maintenance");

    expect(res.id).toBe("notif-1");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: RECIPIENT, type: "ANNOUNCEMENT" });
    expect(frames().map((f) => f.event)).toEqual([
      "notification:new",
      "notification:count_update",
    ]);
  });

  it("gives two different announcements their own row and their own event", async () => {
    const fanout: UnreadFanout = { unreadCount: 1, selfHiddenSessions: [] };
    const { created, sendAnnouncement } = setup(fanout);

    await sendAnnouncement("ann-A", "First");
    fanout.unreadCount = 2;
    await sendAnnouncement("ann-B", "Second");

    // No group key collapses one announcement into the other's card: the list
    // holds A and B once each, and each arrives as its own `notification:new`.
    expect(created).toHaveLength(2);
    expect(frames().map((f) => f.event)).toEqual([
      "notification:new",
      "notification:count_update",
      "notification:new",
      "notification:count_update",
    ]);
    const newFrames = frames().filter((f) => f.event === "notification:new");
    expect(newFrames.map((f) => f.data.notificationId)).toEqual([
      "notif-1",
      "notif-2",
    ]);
  });
});

describe("the frame carries what the badge needs, for every device", () => {
  it("both frames carry the account count and the sessions it over-counts", async () => {
    const { sendAnnouncement } = setup({
      unreadCount: 2, // this device's hidden login alert + the announcement
      selfHiddenSessions: [FRESH_SESSION],
    });

    await sendAnnouncement("ann-A", "Scheduled maintenance");

    for (const frame of frames()) {
      expect(frame.data.unreadCount).toBe(2);
      expect(frame.data.selfHiddenSessions).toEqual([FRESH_SESSION]);
    }
    expect(frames()[1].data.count).toBe(2);
  });

  it("the freshly-logged-in device's badge goes 0 -> 1, not 0 -> 2", async () => {
    // Before: one unread row, the device's own login alert. Its badge reads 0.
    const before: UnreadFanout = {
      unreadCount: 1,
      selfHiddenSessions: [FRESH_SESSION],
    };
    expect(unreadCountForSession(before, FRESH_SESSION)).toBe(0);

    // After: that row plus the announcement.
    const { sendAnnouncement } = setup({
      unreadCount: 2,
      selfHiddenSessions: [FRESH_SESSION],
    });
    await sendAnnouncement("ann-A", "Scheduled maintenance");

    for (const frame of frames()) {
      const badge = unreadCountForSession(
        {
          unreadCount: frame.data.unreadCount as number,
          selfHiddenSessions: frame.data.selfHiddenSessions as string[],
        },
        FRESH_SESSION
      );
      expect(badge).toBe(1);
    }
  });

  it("the account's other device counts the login alert, so it goes 1 -> 2", async () => {
    const { sendAnnouncement } = setup({
      unreadCount: 2,
      selfHiddenSessions: [FRESH_SESSION],
    });

    await sendAnnouncement("ann-A", "Scheduled maintenance");

    const frame = frames()[0];
    expect(
      unreadCountForSession(
        {
          unreadCount: frame.data.unreadCount as number,
          selfHiddenSessions: frame.data.selfHiddenSessions as string[],
        },
        OTHER_SESSION
      )
    ).toBe(2);
  });

  it("an announcement to an account with no login alert is +1 for everyone", async () => {
    const { sendAnnouncement } = setup({
      unreadCount: 1,
      selfHiddenSessions: [],
    });

    await sendAnnouncement("ann-A", "Scheduled maintenance");

    for (const session of [FRESH_SESSION, OTHER_SESSION, undefined]) {
      const frame = frames()[0];
      expect(
        unreadCountForSession(
          {
            unreadCount: frame.data.unreadCount as number,
            selfHiddenSessions: frame.data.selfHiddenSessions as string[],
          },
          session
        )
      ).toBe(1);
    }
  });

  it("two unread login alerts are both subtracted, one per owning session", async () => {
    const { sendAnnouncement } = setup({
      unreadCount: 3, // two login alerts + the announcement
      selfHiddenSessions: [FRESH_SESSION, OTHER_SESSION],
    });

    await sendAnnouncement("ann-A", "Scheduled maintenance");

    const frame = frames()[0];
    const fanout = {
      unreadCount: frame.data.unreadCount as number,
      selfHiddenSessions: frame.data.selfHiddenSessions as string[],
    };
    // Each device hides its OWN alert and counts the other's.
    expect(unreadCountForSession(fanout, FRESH_SESSION)).toBe(2);
    expect(unreadCountForSession(fanout, OTHER_SESSION)).toBe(2);
  });
});

describe("idempotency: the same announcement delivered twice", () => {
  /**
   * The broker can redeliver a batch, and notifications-service holds a Redis
   * `NX` lock per `batchId` for that (announcement.consumer.ts). If one ever
   * gets past it, the count a device applies is still the server's own number
   * for the row set that exists — it is not incremented per frame — so a
   * redelivery cannot inflate the badge even while it is writing a second row.
   */
  it("a redelivered announcement re-states the count, it does not add to it", async () => {
    const fanout: UnreadFanout = {
      unreadCount: 2,
      selfHiddenSessions: [FRESH_SESSION],
    };
    const { sendAnnouncement } = setup(fanout);

    await sendAnnouncement("ann-A", "Scheduled maintenance");
    const firstCounts = frames().map((f) => f.data.unreadCount);

    publishMock.mockClear();
    await sendAnnouncement("ann-A", "Scheduled maintenance");
    const secondCounts = frames().map((f) => f.data.unreadCount);

    expect(firstCounts).toEqual([2, 2]);
    expect(secondCounts).toEqual(firstCounts);
    for (const frame of frames()) {
      expect(
        unreadCountForSession(
          {
            unreadCount: frame.data.unreadCount as number,
            selfHiddenSessions: frame.data.selfHiddenSessions as string[],
          },
          FRESH_SESSION
        )
      ).toBe(1);
    }
  });
});
