/**
 * POST /api/v1/app-version/check — the gateway's only request-body-driven,
 * locally-computed endpoint (no proxy, no downstream). Routing, the
 * `express.json({ limit: "32kb" })` body parser, the Zod validator
 * (`checkAppVersionSchema`), the controller, and the version-compare service all
 * run FOR REAL. The app-version STORE is mocked in global-mocks.ts so `.get()`
 * returns the in-memory defaults derived from env (android/ios = "1.0.0").
 *
 * Default policy under test (from env.ts → getDefaultAppVersionConfig):
 *   android.mandatory = "1.0.0", android.optional = "1.0.0"
 *   ios.mandatory     = "1.0.0", ios.optional     = "1.0.0"
 * So any client >= 1.0.0 is up-to-date; any client < 1.0.0 forces update.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const messagingStub = {} as unknown as MessagingClient;
const app = createApp(messagingStub);

const CHECK = "/api/v1/app-version/check";

describe("POST /api/v1/app-version/check", () => {
  // --- POSITIVE -----------------------------------------------------------
  it("up-to-date android client (version == policy) → isUpToDate", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: "1.0.0" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("App version checked");
    expect(res.body.data).toMatchObject({
      platform: "android",
      clientVersion: "1.0.0",
      minimumRequiredVersion: "1.0.0",
      latestRecommendedVersion: "1.0.0",
      forceUpdate: false,
      optionalUpdate: false,
      isUpToDate: true,
    });
  });

  it("ios client above policy → isUpToDate (no update UI)", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "2.5.9" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      platform: "ios",
      clientVersion: "2.5.9",
      forceUpdate: false,
      optionalUpdate: false,
      isUpToDate: true,
    });
  });

  it("client below mandatory → forceUpdate true", async () => {
    // Policy floor is 1.0.0; "0.9.9" is below it.
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: "0.9.9" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      forceUpdate: true,
      optionalUpdate: false,
      isUpToDate: false,
      minimumRequiredVersion: "1.0.0",
    });
  });

  it("canonicalizes the client version in the response", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "10.20.30" });

    expect(res.status).toBe(200);
    expect(res.body.data.clientVersion).toBe("10.20.30");
  });

  // --- NEGATIVE: validation ------------------------------------------------
  it("missing platform → 400 VALIDATION_FAILED", async () => {
    const res = await request(app).post(CHECK).send({ version: "1.0.0" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
  });

  it("missing version → 400", async () => {
    const res = await request(app).post(CHECK).send({ platform: "android" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("empty body → 400", async () => {
    const res = await request(app).post(CHECK).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("invalid platform enum → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "windows", version: "1.0.0" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("null version → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: null });
    expect(res.status).toBe(400);
  });

  it("empty-string version → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: "" });
    expect(res.status).toBe(400);
  });

  it("non-string version (number) → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: 100 });
    expect(res.status).toBe(400);
  });

  it("malformed version (not major.minor.patch) → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "1.0" });
    expect(res.status).toBe(400);
  });

  it("version with non-numeric segment → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "1.x.0" });
    expect(res.status).toBe(400);
  });

  it("version with leading 'v' prefix → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: "v1.0.0" });
    expect(res.status).toBe(400);
  });

  // --- EDGE ----------------------------------------------------------------
  it("trims surrounding whitespace before validating", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: "  1.2.3  " });

    expect(res.status).toBe(200);
    expect(res.body.data.clientVersion).toBe("1.2.3");
  });

  it("max-width version segments (5 digits) accepted", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "99999.99999.99999" });

    expect(res.status).toBe(200);
    expect(res.body.data.clientVersion).toBe("99999.99999.99999");
    expect(res.body.data.isUpToDate).toBe(true);
  });

  it("over-width version segment (6 digits) rejected → 400", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "ios", version: "100000.0.0" });
    expect(res.status).toBe(400);
  });

  it("rate limiter does NOT block app-version/check (skip rule)", async () => {
    // skipRateLimit() exempts /app-version/check; 150 rapid hits all succeed.
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        request(app).post(CHECK).send({ platform: "android", version: "1.0.0" })
      )
    );
    for (const r of results) {
      expect(r.status).toBe(200);
    }
  });

  // --- SECURITY ------------------------------------------------------------
  it("mass-assignment: extra/privileged body fields are ignored", async () => {
    const res = await request(app).post(CHECK).send({
      platform: "android",
      version: "1.0.0",
      isAdmin: true,
      minimumRequiredVersion: "999.0.0",
      forceUpdate: "tampered",
    });

    expect(res.status).toBe(200);
    // Server-computed values win; injected overrides are dropped.
    expect(res.body.data.minimumRequiredVersion).toBe("1.0.0");
    expect(res.body.data.forceUpdate).toBe(false);
  });

  it("NoSQL-injection-shaped platform object is rejected, not executed", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: { $ne: null }, version: "1.0.0" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("injection-shaped version object is rejected", async () => {
    const res = await request(app)
      .post(CHECK)
      .send({ platform: "android", version: { $gt: "" } });

    expect(res.status).toBe(400);
  });
});
