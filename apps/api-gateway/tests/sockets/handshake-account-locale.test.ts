/**
 * What a connection that declares NO language gets answered in.
 *
 * The reported bug's Vietnamese came from here. A client that sends neither
 * `lang` in `auth`/`query` nor `x-lang` fell straight through to
 * `DEFAULT_LOCALE` — "vi" in production — so every socket-rendered sentence
 * (system lines, list previews, acks) went out in Vietnamese to a user whose
 * app was in English, while their REST reads (which DO send `x-lang`) came back
 * correct. The account's saved language is a language the user actually chose,
 * so it now answers before the server default; anything the connection itself
 * declared still outranks it, because the account field is one slot that five
 * sessions overwrite.
 */
import { DEFAULT_LOCALE } from "@aimess/constants";

import { createGatewaySocketAuthMiddleware } from "../../src/sockets/auth.middleware.js";
import { setAccountLocaleResolver } from "../../src/sockets/account-locale.js";
import { makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

class FakeRedis {
  async get(): Promise<string | null> {
    return null; // unknown session → fail open, same as the REST middleware
  }
}

const middleware = createGatewaySocketAuthMiddleware(
  new FakeRedis() as unknown as Parameters<
    typeof createGatewaySocketAuthMiddleware
  >[0]
);

function connect(handshake: {
  auth?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}): Promise<Record<string, unknown>> {
  const socket = {
    handshake: {
      auth: { token: makeAccessToken(), ...(handshake.auth ?? {}) },
      query: handshake.query ?? {},
      headers: handshake.headers ?? {},
    },
    data: {} as Record<string, unknown>,
  } as unknown as Parameters<typeof middleware>[0];
  return new Promise((resolve) => {
    middleware(socket, () => resolve(socket.data as Record<string, unknown>));
  });
}

afterEach(() => setAccountLocaleResolver(null));

describe("handshake locale — the account language rung", () => {
  it("answers a silent client in the language it saved on its account", async () => {
    setAccountLocaleResolver(async () => "en");

    const data = await connect({});

    expect(data.locale).toBe("en");
    expect(data.userId).toBe(TEST_USER_ID);
  });

  it("NEVER outranks a language the connection declared", async () => {
    setAccountLocaleResolver(async () => "vi");

    expect((await connect({ auth: { lang: "th" } })).locale).toBe("th");
    expect((await connect({ query: { locale: "en" } })).locale).toBe("en");
    expect((await connect({ headers: { "x-lang": "en" } })).locale).toBe("en");
  });

  it("outranks Accept-Language, which is the DEVICE and not a choice", async () => {
    setAccountLocaleResolver(async () => "th");

    const data = await connect({ headers: { "accept-language": "vi-VN,vi" } });

    expect(data.locale).toBe("th");
  });

  it("falls back to the default when the account has no language either", async () => {
    setAccountLocaleResolver(async () => null);
    expect((await connect({})).locale).toBe(DEFAULT_LOCALE);
  });

  it("never fails a handshake because user-service is down", async () => {
    setAccountLocaleResolver(async () => {
      throw new Error("user-service unreachable");
    });

    const data = await connect({});

    expect(data.userId).toBe(TEST_USER_ID);
    expect(data.locale).toBe(DEFAULT_LOCALE);
  });

  it("is not consulted at all with no resolver registered (every unit suite)", async () => {
    expect((await connect({})).locale).toBe(DEFAULT_LOCALE);
  });
});
