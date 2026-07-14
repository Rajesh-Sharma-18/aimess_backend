/**
 * Socket.IO connection-auth middleware (`gatewaySocketAuthMiddleware`).
 *
 * The full Socket.IO server + Redis adapter live ONLY in `src/server.ts` (booting
 * them needs a live Redis and the gRPC clients), so a real end-to-end handshake
 * is out of scope for this harness. The auth GATE, however, is a pure function of
 * `socket.handshake` and the shared `@aimess/auth-jwt` verifier — so we exercise
 * accept/reject end-to-end against a fake socket, with REAL token verification
 * (valid / expired / forged are genuinely distinguishable, same as REST auth).
 *
 * Server→client events and namespace business logic (chat/community/notify) are
 * covered by their own service suites and documented in docs/SOCKET_EVENTS.md;
 * re-driving them here would require booting the adapter and is intentionally
 * deferred.
 */
import { createGatewaySocketAuthMiddleware } from "../../src/sockets/auth.middleware.js";
import {
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
  TEST_SESSION_ID,
} from "../helpers/auth.js";

type Handshake = {
  auth?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
};

/** Fake Redis: `.get()` returns "1" (active) unless a value was preset — e.g. "0" for revoked. */
class FakeRedis {
  constructor(private store: Record<string, string> = {}) {}
  async get(key: string): Promise<string | null> {
    return this.store[key] ?? null;
  }
}

const activeRedis = new FakeRedis() as unknown as Parameters<
  typeof createGatewaySocketAuthMiddleware
>[0];
const gatewaySocketAuthMiddleware =
  createGatewaySocketAuthMiddleware(activeRedis);

/** Build a minimal Socket.IO-shaped object the middleware reads from/writes to. */
function fakeSocket(handshake: Handshake) {
  return {
    handshake: { auth: handshake.auth ?? {}, headers: handshake.headers ?? {} },
    data: {} as Record<string, unknown>,
  } as unknown as Parameters<typeof gatewaySocketAuthMiddleware>[0];
}

/** Run the middleware and resolve with the error it passed to `next` (or null). */
function run(
  handshake: Handshake,
  middleware = gatewaySocketAuthMiddleware
): Promise<Error | null> {
  return new Promise((resolve) => {
    middleware(fakeSocket(handshake), (err) => resolve(err ?? null));
  });
}

describe("gatewaySocketAuthMiddleware — connection auth", () => {
  // --- ACCEPT --------------------------------------------------------------
  it("accepts a valid token via handshake.auth.token and populates socket.data", async () => {
    const socket = fakeSocket({ auth: { token: makeAccessToken() } });
    const err = await new Promise<Error | null>((resolve) => {
      gatewaySocketAuthMiddleware(socket, (e) => resolve(e ?? null));
    });

    expect(err).toBeNull();
    expect(socket.data.userId).toBe(TEST_USER_ID);
    expect(socket.data.sessionId).toBe(TEST_SESSION_ID);
    expect(socket.data.locale).toBeDefined();
  });

  it("accepts a valid token via the Authorization Bearer header", async () => {
    const socket = fakeSocket({
      headers: { authorization: `Bearer ${makeAccessToken()}` },
    });
    const err = await new Promise<Error | null>((resolve) => {
      gatewaySocketAuthMiddleware(socket, (e) => resolve(e ?? null));
    });

    expect(err).toBeNull();
    expect(socket.data.userId).toBe(TEST_USER_ID);
  });

  it("resolves a supported locale from the x-lang header on accept", async () => {
    // Supported locales are ["vi", "en"]; "vi" proves x-lang drives the result.
    const socket = fakeSocket({
      auth: { token: makeAccessToken() },
      headers: { "x-lang": "vi" },
    });
    await new Promise<void>((resolve) => {
      gatewaySocketAuthMiddleware(socket, () => resolve());
    });

    expect(socket.data.locale).toBe("vi");
  });

  it("prefers handshake.auth.token over the Authorization header", async () => {
    const socket = fakeSocket({
      auth: { token: makeAccessToken({ userId: "auth-token-user" }) },
      headers: { authorization: `Bearer ${makeForgedAccessToken()}` },
    });
    const err = await new Promise<Error | null>((resolve) => {
      gatewaySocketAuthMiddleware(socket, (e) => resolve(e ?? null));
    });

    // The good auth.token wins; the forged header is never consulted.
    expect(err).toBeNull();
    expect(socket.data.userId).toBe("auth-token-user");
  });

  // --- REJECT: missing -----------------------------------------------------
  it("rejects when no token is present at all", async () => {
    const err = await run({});
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("Authentication required");
  });

  it("rejects an empty auth object with no header", async () => {
    const err = await run({ auth: {}, headers: {} });
    expect(err?.message).toBe("Authentication required");
  });

  it("rejects a non-Bearer Authorization header (no token extracted)", async () => {
    const err = await run({ headers: { authorization: "Basic abc123" } });
    expect(err?.message).toBe("Authentication required");
  });

  // --- REJECT: invalid -----------------------------------------------------
  it("rejects an expired token", async () => {
    const err = await run({ auth: { token: makeExpiredAccessToken() } });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("Authentication failed");
  });

  it("rejects a forged token (wrong secret)", async () => {
    const err = await run({ auth: { token: makeForgedAccessToken() } });
    expect(err?.message).toBe("Authentication failed");
  });

  it("rejects a structurally-invalid (non-JWT) token", async () => {
    const err = await run({ auth: { token: "not.a.jwt" } });
    expect(err?.message).toBe("Authentication failed");
  });

  // --- SECURITY: tampered token --------------------------------------------
  it("rejects a token with a tampered payload (signature mismatch)", async () => {
    const good = makeAccessToken();
    const [h, , s] = good.split(".");
    const tampered = `${h}.${Buffer.from(
      JSON.stringify({ userId: "attacker", sessionId: "x" })
    ).toString("base64url")}.${s}`;

    const err = await run({ auth: { token: tampered } });
    expect(err?.message).toBe("Authentication failed");
  });

  it("does not populate socket.data when auth fails", async () => {
    const socket = fakeSocket({ auth: { token: makeForgedAccessToken() } });
    await new Promise<void>((resolve) => {
      gatewaySocketAuthMiddleware(socket, () => resolve());
    });

    expect(socket.data.userId).toBeUndefined();
    expect(socket.data.sessionId).toBeUndefined();
  });

  // --- REJECT: revoked session (closes the offline-reconnect window) -------
  it("rejects a structurally-valid token whose session was revoked", async () => {
    const revokedRedis = new FakeRedis({
      [`aimess:session:active:${TEST_SESSION_ID}`]: "0",
    }) as unknown as Parameters<typeof createGatewaySocketAuthMiddleware>[0];
    const middleware = createGatewaySocketAuthMiddleware(revokedRedis);

    const err = await run({ auth: { token: makeAccessToken() } }, middleware);
    expect(err?.message).toBe("Authentication failed");
  });

  it("accepts when the session-active cache has no key yet (fail-open for legacy sessions)", async () => {
    const err = await run({ auth: { token: makeAccessToken() } });
    expect(err).toBeNull();
  });
});
