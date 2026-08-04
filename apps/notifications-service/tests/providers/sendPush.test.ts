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
  });
});
