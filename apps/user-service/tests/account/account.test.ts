/**
 * GET /api/v1/users/accounts/me — connected (social) accounts summary.
 *
 * The connected-accounts service delegates to `resolveAuthAccountSummary`,
 * which (in prod) makes a gRPC call to auth-service. We mock that lib directly
 * so we control the live/unavailable branches and the providers payload.
 */
jest.mock("../../src/lib/resolve-auth-account.js", () => ({
  resolveAuthAccountSummary: jest.fn(),
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { resolveAuthAccountSummary } from "../../src/lib/resolve-auth-account.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const resolve = resolveAuthAccountSummary as unknown as jest.Mock;

const auth = () => bearer(makeAccessToken());

describe("GET /api/v1/users/accounts/me", () => {
  it("returns the linked providers when auth-service is live → 200", async () => {
    resolve.mockResolvedValue({
      account: {
        providers: [
          { provider: "EMAIL", connected: true },
          { provider: "GOOGLE", connected: true, providerEmail: "g@x.com" },
        ],
      },
      accountStatus: "live",
    });

    const res = await request(app).get("/api/v1/users/accounts/me").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accountStatus).toBe("live");
    expect(res.body.data.providers).toHaveLength(2);
  });

  it("returns null providers when auth-service is unavailable", async () => {
    resolve.mockResolvedValue({ account: null, accountStatus: "unavailable" });

    const res = await request(app).get("/api/v1/users/accounts/me").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.providers).toBeNull();
    expect(res.body.data.accountStatus).toBe("unavailable");
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/users/accounts/me");
    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .get("/api/v1/users/accounts/me")
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .get("/api/v1/users/accounts/me")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
