/**
 * Chat ban gate — the `/chat` REST proxy must reject a banned user's still
 * valid access token, and must let everyone else through.
 *
 * A permanent system ban revokes every session and force-disconnects every
 * socket, but the gateway's HTTP proxy is otherwise a passthrough, so an access
 * token minted before the ban kept working against plain REST until it expired.
 *
 * The gate went unexercised while Redis was broken in this service, which is
 * how the two directions that matter most stayed untested: an unbanned user
 * must not be blocked by a leftover flag, and a Redis failure must not 403 the
 * platform.
 */
import type { Request, Response, NextFunction } from "express";

const isUserBanned = jest.fn<Promise<boolean>, [unknown, string]>();

jest.mock("@aimess/redis", () => ({
  __esModule: true,
  getRedis: () => ({}),
  isUserBanned: (client: unknown, userId: string) =>
    isUserBanned(client, userId),
}));

import { createChatBanGate } from "../../src/middleware/ban-gate.js";
import {
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
} from "../helpers/auth.js";

/** Drive the middleware once and report what it did. */
async function run(authorization?: string): Promise<{
  passed: boolean;
  status?: number;
  body?: { code?: string };
}> {
  const gate = createChatBanGate();
  const req = { headers: { authorization } } as unknown as Request;

  let passed = false;
  let status: number | undefined;
  let body: { code?: string } | undefined;

  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: { code?: string }) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  await new Promise<void>((resolve) => {
    const next: NextFunction = () => {
      passed = true;
      resolve();
    };
    const original = res.json.bind(res);
    (res as unknown as { json: (p: { code?: string }) => unknown }).json = (
      payload
    ) => {
      const out = original(payload);
      resolve();
      return out;
    };
    gate(req, res, next);
  });

  return { passed, status, body };
}

describe("chat ban gate", () => {
  beforeEach(() => {
    isUserBanned.mockReset();
  });

  it("lets a user through when no ban key exists", async () => {
    isUserBanned.mockResolvedValue(false);

    const result = await run(`Bearer ${makeAccessToken()}`);

    expect(result.passed).toBe(true);
    expect(isUserBanned).toHaveBeenCalledWith(expect.anything(), TEST_USER_ID);
  });

  it("rejects a user whose ban key is set", async () => {
    isUserBanned.mockResolvedValue(true);

    const result = await run(`Bearer ${makeAccessToken()}`);

    expect(result.passed).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body?.code).toBe("ACCOUNT_BANNED");
  });

  it("lets the same user through again once the ban key is removed", async () => {
    // The unban direction. `accountBanService.lift` DELs the key before it
    // flips the status row, so the very next request reads a missing key —
    // there is no TTL to wait out and no second source of truth to reconcile.
    isUserBanned.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const token = `Bearer ${makeAccessToken()}`;
    expect((await run(token)).status).toBe(403);
    expect((await run(token)).passed).toBe(true);
  });

  it("reads the flag once per request", async () => {
    // The gate adds a Redis round trip to every chat REST call, so it must not
    // add more than one. chat-service checks again behind it, deliberately —
    // that is a second process across a trust boundary, not a duplicate here.
    isUserBanned.mockResolvedValue(false);

    await run(`Bearer ${makeAccessToken()}`);

    expect(isUserBanned).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN when Redis is unavailable", async () => {
    // Deliberate: chat-service still enforces membership and room state on
    // every write, so a Redis blip must not take down all chat REST. Only a
    // POSITIVE confirmation blocks.
    isUserBanned.mockRejectedValue(new Error("ECONNREFUSED"));

    expect((await run(`Bearer ${makeAccessToken()}`)).passed).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["a garbage header", "Bearer not-a-token"],
  ])("passes %s straight through for the service to reject", async (_l, h) => {
    // The gate never changes auth semantics for non-banned users: an absent or
    // unreadable token is the downstream service's 401 to issue.
    const result = await run(h);

    expect(result.passed).toBe(true);
    expect(isUserBanned).not.toHaveBeenCalled();
  });

  it("does not consult Redis for an expired or forged token", async () => {
    expect((await run(`Bearer ${makeExpiredAccessToken()}`)).passed).toBe(true);
    expect((await run(`Bearer ${makeForgedAccessToken()}`)).passed).toBe(true);
    expect(isUserBanned).not.toHaveBeenCalled();
  });
});
