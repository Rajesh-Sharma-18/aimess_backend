/**
 * Where a socket's language comes from, and what it takes to change it.
 *
 * A browser cannot set request headers on a websocket upgrade, so the app's
 * selected language can only travel in the connect packet's `auth` or the
 * handshake query. Both must outrank `x-lang`/`Accept-Language`, which for a
 * browser carry the OS language — otherwise the chain falls through to
 * DEFAULT_LOCALE ("vi" in production) and an English reader gets Vietnamese
 * system messages live while REST history reads correctly.
 */
import { DEFAULT_LOCALE } from "@aimess/constants";

import { resolveHandshakeLocale } from "../../src/sockets/auth.middleware.js";
import { scopeSocketLocale } from "../../src/sockets/locale-scope.js";

const handshake = (over: {
  auth?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}) => ({ auth: over.auth, query: over.query, headers: over.headers ?? {} });

describe("resolveHandshakeLocale", () => {
  it("prefers the client-sent auth locale over the browser's headers", () => {
    expect(
      resolveHandshakeLocale(
        handshake({
          auth: { lang: "en" },
          headers: { "accept-language": "vi-VN,vi;q=0.9" },
        })
      )
    ).toBe("en");
  });

  it("accepts `locale` as well as `lang`, and reads the query string too", () => {
    expect(resolveHandshakeLocale(handshake({ auth: { locale: "th" } }))).toBe(
      "th"
    );
    expect(resolveHandshakeLocale(handshake({ query: { lang: "th" } }))).toBe(
      "th"
    );
  });

  it("accepts every spelling of the field in BOTH channels", () => {
    // A client that declares its language and is ignored is indistinguishable
    // from one that never declared it — and the cost is the production default.
    expect(
      resolveHandshakeLocale(handshake({ auth: { language: "th" } }))
    ).toBe("th");
    expect(resolveHandshakeLocale(handshake({ query: { locale: "th" } }))).toBe(
      "th"
    );
    expect(
      resolveHandshakeLocale(handshake({ query: { language: "th" } }))
    ).toBe("th");
  });

  it("still honours x-lang, then Accept-Language, for clients that send neither", () => {
    expect(
      resolveHandshakeLocale(
        handshake({
          headers: { "x-lang": "th", "accept-language": "en-US" },
        })
      )
    ).toBe("th");
    expect(
      resolveHandshakeLocale(
        handshake({ headers: { "accept-language": "th" } })
      )
    ).toBe("th");
  });

  it("ignores an empty or whitespace-only value instead of treating it as a choice", () => {
    expect(
      resolveHandshakeLocale(
        handshake({
          auth: { lang: "  " },
          headers: { "accept-language": "th" },
        })
      )
    ).toBe("th");
  });

  it("falls back to the default only when nothing at all is supplied", () => {
    expect(resolveHandshakeLocale(handshake({}))).toBe(DEFAULT_LOCALE);
  });
});

describe("locale:set — retargeting an open connection", () => {
  const fakeSocket = () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      data: {
        locale: "vi" as string,
        userId: "user-1",
        sessionId: "sess-1",
      },
      use: jest.fn(),
      on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
        handlers.set(event, fn);
      }),
      fire: (event: string, ...args: unknown[]) =>
        handlers.get(event)?.(...args),
    };
  };

  it("moves the live locale without waiting for a reconnect", () => {
    const socket = fakeSocket();
    scopeSocketLocale(socket as never);

    socket.fire("locale:set", { lang: "en" });

    expect(socket.data.locale).toBe("en");
  });

  it("accepts a region subtag and a bare string payload", () => {
    const socket = fakeSocket();
    scopeSocketLocale(socket as never);

    socket.fire("locale:set", { lang: "th-TH" });
    expect(socket.data.locale).toBe("th");

    socket.fire("locale:set", "en-US");
    expect(socket.data.locale).toBe("en");
  });

  it("KEEPS the previous locale for an unsupported language, never the default", () => {
    const socket = fakeSocket();
    socket.data.locale = "en";
    scopeSocketLocale(socket as never);

    // Hindi is not in SUPPORTED_LOCALES. Normalizing it would answer this
    // English reader in Vietnamese in production — the exact bug being fixed.
    socket.fire("locale:set", { lang: "hi" });

    expect(socket.data.locale).toBe("en");
  });

  it("reports failure to the client while leaving the locale alone", () => {
    const socket = fakeSocket();
    socket.data.locale = "en";
    scopeSocketLocale(socket as never);
    const ack = jest.fn();

    socket.fire("locale:set", { lang: "hi" }, ack);

    expect(ack).toHaveBeenCalledWith({
      success: false,
      data: { locale: "en" },
    });
  });
});

describe("locale:set — telling the push side, which cannot see this packet", () => {
  const fakeSocket = (over: Record<string, unknown> = {}) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      data: { locale: "vi", userId: "user-1", sessionId: "sess-1", ...over },
      use: jest.fn(),
      on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
        handlers.set(event, fn);
      }),
      fire: (event: string, ...args: unknown[]) =>
        handlers.get(event)?.(...args),
    };
  };
  const fakeRedis = () => ({ publish: jest.fn().mockResolvedValue(1) });

  it("publishes the session's new language so the push tray can follow it", () => {
    const socket = fakeSocket();
    const redis = fakeRedis();
    scopeSocketLocale(socket as never, redis as never);

    socket.fire("locale:set", { lang: "th" });

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, body] = redis.publish.mock.calls[0] as [string, string];
    expect(channel).toBe("session:locale");
    expect(JSON.parse(body)).toEqual({
      userId: "user-1",
      sessionId: "sess-1",
      locale: "th",
    });
  });

  it("says nothing when the language did not actually change to a supported one", () => {
    const socket = fakeSocket();
    const redis = fakeRedis();
    scopeSocketLocale(socket as never, redis as never);

    socket.fire("locale:set", { lang: "hi" });

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("still moves the socket when there is no publisher wired (unit suites)", () => {
    const socket = fakeSocket();
    scopeSocketLocale(socket as never);

    socket.fire("locale:set", { lang: "en" });

    expect(socket.data.locale).toBe("en");
  });

  it("never lets a failed publish break the packet that expressed the change", () => {
    const socket = fakeSocket();
    const redis = { publish: jest.fn().mockRejectedValue(new Error("down")) };
    scopeSocketLocale(socket as never, redis as never);
    const ack = jest.fn();

    expect(() => socket.fire("locale:set", { lang: "en" }, ack)).not.toThrow();
    expect(socket.data.locale).toBe("en");
    expect(ack).toHaveBeenCalledWith({ success: true, data: { locale: "en" } });
  });

  it("cannot publish for a socket with no session to name", () => {
    const socket = fakeSocket({ sessionId: "" });
    const redis = fakeRedis();
    scopeSocketLocale(socket as never, redis as never);

    socket.fire("locale:set", { lang: "th" });

    expect(redis.publish).not.toHaveBeenCalled();
    expect(socket.data.locale).toBe("th");
  });
});
