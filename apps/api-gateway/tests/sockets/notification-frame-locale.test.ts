/**
 * The realtime half of "a notification reads in the user's CURRENT language".
 *
 * One user, two devices, two languages. `/notify` relays a single Redis frame,
 * so without a per-socket rewrite both devices would show whichever language
 * the writer happened to bake in. The frame carries the replay ticket
 * (`data.copyRef`), and this rebuilds the sentence per connected socket — the
 * same seam group SYSTEM messages already use.
 */
import { callCopy, friendCopy, resolutionCopy, t } from "@aimess/constants";

import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";
import { localizeNotificationFrame } from "../../src/sockets/localize-notification.js";

interface FakeSocket {
  data: { userId: string; locale: string; sessionId?: string };
  emit: jest.Mock;
}

function fakeNamespace(sockets: FakeSocket[]) {
  return {
    in: () => ({ fetchSockets: async () => sockets }),
    to: () => ({ emit: jest.fn() }),
  } as never;
}

const device = (locale: string, sessionId = `s-${locale}`): FakeSocket => ({
  data: { userId: "viewer-1", locale, sessionId },
  emit: jest.fn(),
});

const CALLER = "Mohit Vasundhara";

/** Exactly the shape `createNotificationImpl` publishes. */
function missedCallFrame() {
  const copy = callCopy.activity(CALLER, "AUDIO", "MISSED", "INCOMING", 0, 0);
  return {
    notificationId: "n1",
    type: "call.activity",
    title: CALLER,
    body: copy("vi").body,
    isRead: false,
    createdAt: 1_760_000_000_000,
    data: {
      callId: "c1",
      callType: "AUDIO",
      callStatus: "MISSED",
      callDirection: "INCOMING",
      inboxTitle: CALLER,
      copyRef: JSON.stringify(copy.descriptor),
    },
  };
}

const bodyOf = (s: FakeSocket): string =>
  (s.emit.mock.calls[0][1] as { body: string }).body;

describe("/notify frame localization", () => {
  it("delivers one notification to two devices in two languages", async () => {
    const phone = device("vi");
    const laptop = device("en");

    await emitPersonalizedSender(
      fakeNamespace([phone, laptop]),
      "user:viewer-1",
      "notification:new",
      missedCallFrame(),
      localizeNotificationFrame
    );

    expect(bodyOf(phone)).toBe(t("NOTIF_CALL_MISSED_VOICE", "vi"));
    expect(bodyOf(laptop)).toBe(t("NOTIF_CALL_MISSED_VOICE", "en"));
  });

  it("never translates the caller's name or the row's identity", async () => {
    const th = device("th");
    await emitPersonalizedSender(
      fakeNamespace([th]),
      "user:viewer-1",
      "notification:new",
      missedCallFrame(),
      localizeNotificationFrame
    );

    const payload = th.emit.mock.calls[0][1] as {
      title: string;
      notificationId: string;
      createdAt: number;
      data: Record<string, string>;
    };
    expect(payload.title).toBe(CALLER);
    expect(payload.notificationId).toBe("n1");
    expect(payload.createdAt).toBe(1_760_000_000_000);
    expect(payload.data.callStatus).toBe("MISSED");
  });

  it("localizes the friend-card resolution line per device", async () => {
    const copy = friendCopy.requested("Ana");
    const extra = resolutionCopy.friendAccepted("Ana");
    const frame = {
      notificationId: "n2",
      type: "friend.requested",
      title: null,
      body: copy("en").body,
      resolution: extra("en").resolution,
      data: {
        suppressTitle: "true",
        copyRef: JSON.stringify(copy.descriptor),
        dataRef: JSON.stringify(extra.descriptor),
      },
    };
    const vi = device("vi");

    await emitPersonalizedSender(
      fakeNamespace([vi]),
      "user:viewer-1",
      "notification:new",
      frame,
      localizeNotificationFrame
    );

    const payload = vi.emit.mock.calls[0][1] as {
      title: string | null;
      body: string;
      resolution: string;
    };
    expect(payload.body).toBe(
      t("NOTIF_FRIEND_REQUESTED", "vi", { name: "Ana" })
    );
    expect(payload.resolution).toBe(
      t("NOTIF_FRIEND_RESOLUTION_ACCEPTED", "vi", { name: "Ana" })
    );
    // A row the serializer decided has no heading must not grow one back.
    expect(payload.title).toBeNull();
  });

  it("passes ticketless and non-notification frames through untouched", async () => {
    const en = device("en");
    const announcement = {
      notificationId: "n3",
      type: "ANNOUNCEMENT",
      title: "Scheduled maintenance",
      body: "We will be down 02:00-03:00 UTC.",
      data: {},
    };

    await emitPersonalizedSender(
      fakeNamespace([en]),
      "user:viewer-1",
      "notification:new",
      announcement,
      localizeNotificationFrame
    );
    expect(en.emit.mock.calls[0][1]).toEqual(announcement);

    const counts = device("vi");
    await emitPersonalizedSender(
      fakeNamespace([counts]),
      "user:viewer-1",
      "notification:count_update",
      { count: 3, unreadCount: 3 },
      localizeNotificationFrame
    );
    expect(counts.emit.mock.calls[0][1]).toEqual({ count: 3, unreadCount: 3 });
  });

  it("still withholds a login alert from the device that caused it", async () => {
    const newDevice = device("en", "session-new");
    const otherDevice = device("vi", "session-old");

    await emitPersonalizedSender(
      fakeNamespace([newDevice, otherDevice]),
      "user:viewer-1",
      "notification:new",
      missedCallFrame(),
      localizeNotificationFrame,
      undefined,
      undefined,
      "session-new"
    );

    expect(newDevice.emit).not.toHaveBeenCalled();
    expect(bodyOf(otherDevice)).toBe(t("NOTIF_CALL_MISSED_VOICE", "vi"));
  });
});
