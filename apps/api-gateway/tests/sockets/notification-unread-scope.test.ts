/**
 * The badge a device is shown must be the badge its own list can explain.
 *
 * A login-detected notification is withheld from the device that login created
 * — list, per-tab counts and `/unread-count` all hide it — but it is one row on
 * one account, so the account-wide unread count includes it. Broadcasting that
 * bare number left the device that had just signed in showing "1" over an inbox
 * with nothing unread in it, and only a refetch ever cleared it.
 *
 * chat-service now publishes the account-wide count plus `selfHiddenSessions`,
 * and the gateway resolves it per socket. These are the rules that fixes.
 */
import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";
import { localizeNotificationFrame } from "../../src/sockets/localize-notification.js";
import {
  scopeUnreadFrame,
  unreadCountForSession,
} from "../../src/sockets/unread-count-scope.js";

interface FakeSocket {
  data: { userId: string; locale: string; sessionId?: string };
  emit: jest.Mock;
}

function fakeNamespace(sockets: FakeSocket[]) {
  return {
    local: { in: () => ({ fetchSockets: async () => sockets }) },
    in: () => ({ fetchSockets: async () => sockets }),
    to: () => ({ emit: jest.fn() }),
  } as never;
}

const device = (sessionId: string, locale = "en"): FakeSocket => ({
  data: { userId: "viewer-1", locale, sessionId },
  emit: jest.fn(),
});

/** Exactly what `/notify` composes for every frame it relays. */
const personalize = Object.assign(
  (data: unknown, userId: string, locale: string, sessionId?: string) =>
    scopeUnreadFrame(
      localizeNotificationFrame(data, userId, locale as never),
      sessionId
    ),
  { perSession: true }
);

const countFrame = (
  unreadCount: number,
  selfHiddenSessions: string[] = []
) => ({
  count: unreadCount,
  unreadCount,
  selfHiddenSessions,
});

const payloadOf = (s: FakeSocket) =>
  s.emit.mock.calls[0][1] as Record<string, unknown>;

describe("unreadCountForSession", () => {
  it("leaves a count alone when nothing is hidden from this session", () => {
    expect(unreadCountForSession(3, [], "s-1")).toBe(3);
    expect(unreadCountForSession(3, undefined, "s-1")).toBe(3);
  });

  it("subtracts only the rows hidden from THIS session", () => {
    expect(unreadCountForSession(3, ["s-2"], "s-1")).toBe(3);
    expect(unreadCountForSession(3, ["s-1"], "s-1")).toBe(2);
    expect(unreadCountForSession(3, ["s-1", "s-1", "s-2"], "s-1")).toBe(1);
  });

  it("never goes negative, and a socket with no session keeps the total", () => {
    expect(unreadCountForSession(1, ["s-1", "s-1"], "s-1")).toBe(0);
    expect(unreadCountForSession(2, ["s-1"], undefined)).toBe(2);
  });
});

describe("scopeUnreadFrame", () => {
  it("returns a frame that carries no hidden set untouched", () => {
    const frame = { unreadCount: 4, count: 4 };
    expect(scopeUnreadFrame(frame, "s-1")).toBe(frame);
  });

  it("drops the hidden set — it is routing detail, not client state", () => {
    const out = scopeUnreadFrame(countFrame(2, ["s-2"]), "s-1") as Record<
      string,
      unknown
    >;
    expect(out.selfHiddenSessions).toBeUndefined();
    expect(out).toEqual({ count: 2, unreadCount: 2 });
  });

  it("is idempotent — re-scoping an already-scoped frame cannot double-count", () => {
    const once = scopeUnreadFrame(countFrame(2, ["s-1"]), "s-1");
    expect(once).toEqual({ count: 1, unreadCount: 1 });
    expect(scopeUnreadFrame(once, "s-1")).toBe(once);
  });

  it("scopes a `notification:deleted` frame the same way, keeping its id", () => {
    const out = scopeUnreadFrame(
      { notificationId: "n9", unreadCount: 1, selfHiddenSessions: ["s-1"] },
      "s-1"
    ) as Record<string, unknown>;
    expect(out).toEqual({ notificationId: "n9", unreadCount: 0 });
  });
});

describe("/notify fan-out of one count to two devices", () => {
  it("hides a device's own login alert from ITS badge and nobody else's", async () => {
    // `justLoggedIn` is the session the login-detected row was raised for: its
    // list never shows that row, so its badge must not count it either.
    const justLoggedIn = device("s-new");
    const otherDevice = device("s-old");

    await emitPersonalizedSender(
      fakeNamespace([justLoggedIn, otherDevice]),
      "user:viewer-1",
      "notification:count_update",
      countFrame(1, ["s-new"]),
      personalize
    );

    expect(payloadOf(justLoggedIn)).toEqual({ count: 0, unreadCount: 0 });
    expect(payloadOf(otherDevice)).toEqual({ count: 1, unreadCount: 1 });
  });

  it("does not let two devices of one account share a rendered count", async () => {
    // Same user, same language: the render cache collapses those into one
    // payload unless the rewrite declares itself per-session. It does — so the
    // second device must not be handed the first device's number.
    const a = device("s-a");
    const b = device("s-b");

    await emitPersonalizedSender(
      fakeNamespace([a, b]),
      "user:viewer-1",
      "notification:count_update",
      countFrame(2, ["s-a"]),
      personalize
    );

    expect(payloadOf(a)).toEqual({ count: 1, unreadCount: 1 });
    expect(payloadOf(b)).toEqual({ count: 2, unreadCount: 2 });
  });

  it("marking the last unread read clears the badge on every device", async () => {
    const a = device("s-a");
    const b = device("s-b");

    await emitPersonalizedSender(
      fakeNamespace([a, b]),
      "user:viewer-1",
      "notification:all-read",
      { unreadCount: 0, selfHiddenSessions: [] },
      personalize
    );

    expect(payloadOf(a)).toEqual({ unreadCount: 0 });
    expect(payloadOf(b)).toEqual({ unreadCount: 0 });
  });

  it("still localizes the frame it scopes", async () => {
    // Both rewrites run over the same payload — a count-bearing
    // `notification:new` must not lose its per-device language to gain a
    // per-device count.
    const vi = device("s-vi", "vi");
    const en = device("s-en", "en");
    const frame = {
      notificationId: "n1",
      type: "friend.accepted",
      title: "Ana",
      body: "baked at write time",
      unreadCount: 1,
      selfHiddenSessions: ["s-vi"],
      data: { inboxTitle: "Ana" },
    };

    await emitPersonalizedSender(
      fakeNamespace([vi, en]),
      "user:viewer-1",
      "notification:new",
      frame,
      personalize
    );

    const viPayload = payloadOf(vi);
    const enPayload = payloadOf(en);
    expect(viPayload.unreadCount).toBe(0);
    expect(enPayload.unreadCount).toBe(1);
    expect(viPayload.selfHiddenSessions).toBeUndefined();
    expect(viPayload.notificationId).toBe("n1");
  });
});
