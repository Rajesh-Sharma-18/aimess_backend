/**
 * Ack copy follows the SOCKET, live — not the language the connection opened in.
 *
 * Every namespace resolves `socket.data.locale` once in its `connection`
 * handler and passes that copy to every ack site. `locale:set` moves the locale
 * of an open connection, so that copy is stale from the moment a user switches
 * language: the reported symptom was a session showing English UI while
 * `community:message:send:ack` kept answering `"Đã gửi tin nhắn"`.
 *
 * The ambient locale published per inbound packet by `scopeSocketLocale` is
 * read from the LIVE `socket.data.locale`, so it is both current AND per socket
 * — which is what keeps two sessions of one account from answering in each
 * other's language.
 */
import { runWithLocale, t } from "@aimess/constants";

import { ackOk, ackError } from "../../src/sockets/ack.js";
import { scopeSocketLocale } from "../../src/sockets/locale-scope.js";

type Middleware = (packet: unknown[], next: () => void) => void;

/** A socket double that actually runs the `socket.use()` packet middleware. */
function fakeSocket(locale: string) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let middleware: Middleware | undefined;
  const socket = {
    data: { locale },
    use: (fn: Middleware) => {
      middleware = fn;
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      handlers.set(event, fn);
    },
    fire: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    /** Deliver an inbound packet the way Socket.IO does: handler inside next(). */
    packet: (handler: () => void) => {
      if (!middleware) throw new Error("scopeSocketLocale did not install one");
      middleware(["some:event"], handler);
    },
  };
  scopeSocketLocale(socket as never);
  return socket;
}

describe("ack copy on a connection that changed language", () => {
  it("answers in the language set by locale:set, not the one it connected in", () => {
    const socket = fakeSocket("vi");
    // What the namespace captured at connect time and still passes to every ack.
    const frozen = "vi" as const;
    const ack = jest.fn();

    socket.fire("locale:set", { lang: "en" });
    socket.packet(() =>
      ackOk(ack, "SOCKET_COMMUNITY_MESSAGE_SENT", frozen, { messageId: "m1" })
    );

    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: "Message sent successfully",
      data: { messageId: "m1" },
    });
  });

  it("localizes the error envelope the same way, detail key included", () => {
    const socket = fakeSocket("vi");
    const ack = jest.fn();

    socket.fire("locale:set", { lang: "th" });
    socket.packet(() => ackError(ack, "INVALID_PAYLOAD", "vi"));

    const [envelope] = ack.mock.calls[0] as [{ message: string }];
    expect(envelope.message).not.toBe("");
    // Same key, resolved for the socket's CURRENT language.
    expect(envelope.message).toBe(t("SOCKET_ERR_INVALID_PAYLOAD", "th"));
  });

  it("keeps two sessions of one account apart", () => {
    const vietnamese = fakeSocket("vi");
    const english = fakeSocket("en");
    const viAck = jest.fn();
    const enAck = jest.fn();

    // Interleaved, as two devices of one user genuinely are.
    vietnamese.packet(() => {
      ackOk(viAck, "SOCKET_COMMUNITY_MESSAGE_SENT", "vi");
      english.packet(() => ackOk(enAck, "SOCKET_COMMUNITY_MESSAGE_SENT", "en"));
    });

    expect(viAck.mock.calls[0][0]).toMatchObject({
      message: "Đã gửi tin nhắn",
    });
    expect(enAck.mock.calls[0][0]).toMatchObject({
      message: "Message sent successfully",
    });
  });

  it("falls back to the passed locale when there is no inbound packet", () => {
    const ack = jest.fn();

    // A timer-driven ack: no `socket.use()` scope around it.
    ackOk(ack, "SOCKET_COMMUNITY_MESSAGE_SENT", "th");

    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: "ส่งข้อความเรียบร้อยแล้ว",
    });
  });

  it("does not let an unrelated ambient locale outrank a packet's own", () => {
    const socket = fakeSocket("en");
    const ack = jest.fn();

    runWithLocale("vi", () =>
      socket.packet(() => ackOk(ack, "SOCKET_COMMUNITY_MESSAGE_SENT", "vi"))
    );

    expect(ack.mock.calls[0][0]).toMatchObject({
      message: "Message sent successfully",
    });
  });
});
