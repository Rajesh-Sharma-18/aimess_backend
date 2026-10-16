/**
 * Coverage for sendPush.ts's platform-specific collapse/grouping headers —
 * added alongside the multi-device call-notification-sync fix and the
 * conversation-based thread-id grouping work.
 *
 * global-mocks.ts mocks `providers/firebase/firebase.js` so `messaging.send`
 * is a jest.fn() we can assert the raw FCM SendMessage payload against.
 */
import { messaging } from "../../src/providers/firebase/firebase.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";

const sendMock = messaging.send as jest.Mock;

describe("sendPush — platform collapse/grouping headers", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue("msg-id-1");
  });

  it("forwards collapseKey to android.collapseKey AND webpush Topic header (Web Push's own collapse mechanism)", async () => {
    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      collapseKey: "call:call123",
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.android.collapseKey).toBe("call:call123");
    expect(arg.webpush.headers.Topic).toBe("call:call123");
  });

  it("omits Topic header when no collapseKey is given", async () => {
    await sendPush({ token: "tok1", title: "Alice", body: "hi" });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.webpush.headers.Topic).toBeUndefined();
  });

  it("forwards apnsThreadId to apns-thread-id header for iOS grouping", async () => {
    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      apnsThreadId: "chat_conv1",
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-thread-id"]).toBe("chat_conv1");
  });

  it("dataOnly pushes (calls) omit the top-level notification block so the client owns the UI", async () => {
    await sendPush({
      token: "tok1",
      title: "",
      body: "",
      dataOnly: true,
      collapseKey: "call:call123",
      data: { type: "CALL_CANCELLED", callId: "call123" },
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.notification).toBeUndefined();
    expect(arg.apns.payload.aps.contentAvailable).toBe(true);
    // Collapse headers still apply to dataOnly pushes — this is exactly the
    // CALL_CANCELLED path that must replace/dismiss a still-queued ring.
    expect(arg.android.collapseKey).toBe("call:call123");
    expect(arg.webpush.headers.Topic).toBe("call:call123");
    expect(arg.apns.headers["apns-collapse-id"]).toBe("call:call123");
  });

  // apns-collapse-id was missing entirely, which made iOS the one platform
  // where a queued CALL_INCOMING was never replaced by its own CALL_CANCELLED
  // — the ring came back for a call that had already been declined.
  it("forwards collapseKey to apns-collapse-id so iOS replaces a queued notification instead of stacking", async () => {
    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      collapseKey: "call:call123",
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-collapse-id"]).toBe("call:call123");
  });

  it("omits apns-collapse-id when no collapseKey is given", async () => {
    await sendPush({ token: "tok1", title: "Alice", body: "hi" });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-collapse-id"]).toBeUndefined();
  });

  // APNs rejects the whole request with BadCollapseId past 64 bytes, which
  // would drop the notification. Degrade to stacking rather than losing it.
  it("omits apns-collapse-id when the key exceeds the 64-byte APNs limit, keeping the other platforms", async () => {
    const oversized = `call:${"x".repeat(60)}`;
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(64);

    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      collapseKey: oversized,
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-collapse-id"]).toBeUndefined();
    expect(arg.android.collapseKey).toBe(oversized);
    expect(arg.webpush.headers.Topic).toBe(oversized);
  });

  // AIMESS-113: the app draws missed calls (round caller icon), so Android gets data-only + copy.
  it("sends CALL_MISSED data-only on Android with pushTitle/pushBody and no image", async () => {
    await sendPush({
      token: "tok1",
      title: "Missed call",
      body: "from Alice",
      platform: "ANDROID",
      imageUrl: "https://cdn.example/alice.jpg",
      data: { type: "CALL_MISSED", callId: "call123" },
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.notification).toBeUndefined();
    expect(arg.android.notification).toBeUndefined();
    expect(arg.data.pushTitle).toBe("Missed call");
    expect(arg.data.pushBody).toBe("from Alice");
  });

  it("does not stamp channelId on non-CALL_MISSED Android notifications", async () => {
    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      platform: "ANDROID",
      // A generic MESSAGE goes data-only on Android (androidOwnsRendering), so
      // notification block is omitted entirely — no channelId to check.
      data: { type: "MESSAGE" },
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.android.notification).toBeUndefined();
  });

  it("omits apns-collapse-id for chat MESSAGE pushes so iOS cards stack, keeping data.tag-based dismissal", async () => {
    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      collapseKey: "conv:prv_room1",
      apnsThreadId: "chat_prv_room1",
      data: { type: "MESSAGE", conversationId: "prv_room1", tag: "conv:prv_room1" },
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-collapse-id"]).toBeUndefined();
    expect(arg.apns.headers["apns-thread-id"]).toBe("chat_prv_room1");
    expect(arg.data.tag).toBe("conv:prv_room1");
    // Other platforms keep their own collapse behaviour.
    expect(arg.android.collapseKey).toBe("conv:prv_room1");
    expect(arg.webpush.headers.Topic).toBe("conv:prv_room1");
  });

  it("keeps a key exactly at the 64-byte boundary", async () => {
    const exact = "y".repeat(64);

    await sendPush({
      token: "tok1",
      title: "Alice",
      body: "hi",
      collapseKey: exact,
    });

    const arg = sendMock.mock.calls[0][0];
    expect(arg.apns.headers["apns-collapse-id"]).toBe(exact);
  });
});

describe("sendPush — missed-call web grouping (§9.1)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue("msg-id-1");
  });

  it("sets webpush tag + renotify alongside android/apns collapse", async () => {
    await sendPush({ token: "t", title: "Ann", body: "2 missed voice calls", collapseKey: "missed:u1", renotify: true });
    const arg = sendMock.mock.calls[0][0];
    expect(arg.webpush.notification).toMatchObject({ tag: "missed:u1", renotify: true });
    expect(arg.android.collapseKey).toBe("missed:u1");
    expect(arg.apns.headers["apns-collapse-id"]).toBe("missed:u1");
  });

  it("never renotifies without being asked", async () => {
    await sendPush({ token: "t", title: "Ann", body: "hi", collapseKey: "conv:r1" });
    expect(sendMock.mock.calls[0][0].webpush.notification.renotify).toBeUndefined();
  });
});
