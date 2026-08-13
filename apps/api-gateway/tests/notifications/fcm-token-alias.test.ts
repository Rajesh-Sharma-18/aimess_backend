/**
 * Backward-compatible alias:
 *   POST /api/v1/notifications/fcm-token
 *     → forwarded to notifications-service POST /v1/devices
 *
 * The gateway→notifications hop is a server-side `fetch`, mocked here so no
 * network is needed. notifications-service does the JWT auth + Zod validation
 * and returns the SAME response shape, so the alias relays its status + body
 * verbatim. Mounted only when NOTIFICATION_SERVICE_URL is set (provided by
 * tests/setup/env.ts).
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const URL = "/api/v1/notifications/fcm-token";
const TOKEN = "Bearer test.jwt.token";

function makeApp() {
  return createApp({} as unknown as MessagingClient);
}

describe("POST /api/v1/notifications/fcm-token (alias → notifications-service)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards the canonical body + auth to /v1/devices and relays 200 verbatim", async () => {
    const upstreamBody = { success: true };
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(upstreamBody),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .set("x-lang", "en")
      .send({ token: "fcm-abc", platform: "ANDROID", deviceId: "dev-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(upstreamBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/v1\/devices$/);
    expect(JSON.parse(init.body as string)).toEqual({
      token: "fcm-abc",
      platform: "ANDROID",
      deviceId: "dev-1",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(headers["x-lang"]).toBe("en");
  });

  it("normalizes aliases: fcmToken→token, deviceType→platform, upper-cases platform", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ fcmToken: "fcm-xyz", deviceType: "ios" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      token: "fcm-xyz",
      platform: "IOS",
    });
  });

  // An iOS/Android PushKit token registered through the alias used to lose its
  // tokenType and be stored as FCM, so call rings were sent over FCM and never
  // reached PushKit.
  it("forwards tokenType so a VOIP token is not silently stored as FCM", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ token: "voip-abc", platform: "IOS", tokenType: "VOIP" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      token: "voip-abc",
      platform: "IOS",
      tokenType: "VOIP",
    });
  });

  it("relays a 400 validation error from notifications-service verbatim", async () => {
    global.fetch = jest.fn(async () => ({
      status: 400,
      text: async () =>
        JSON.stringify({ success: false, message: "platform is required" }),
    })) as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ token: "fcm-abc" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("relays a 401 from notifications-service (unauthenticated upstream)", async () => {
    global.fetch = jest.fn(async () => ({
      status: 401,
      text: async () =>
        JSON.stringify({ success: false, message: "Unauthorized" }),
    })) as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .send({ token: "fcm-abc", platform: "ANDROID" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 503 when the notifications-service hop fails", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ token: "fcm-abc", platform: "ANDROID" });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});

/**
 * The native clients' documented logout step. It had NO route on the gateway,
 * so every mobile logout 404'd on the unregister and the row survived until the
 * server-side session revocation caught it (or, if that event was lost, forever).
 */
describe("DELETE /api/v1/notifications/fcm-token/:token (alias → notifications-service)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards to DELETE /v1/devices/:token with the caller's JWT", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true, removed: true }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .delete(`${URL}/fcm-abc`)
      .set("Authorization", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: true });

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/v1\/devices\/fcm-abc$/);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it("url-encodes a token containing path-unsafe characters", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true, removed: true }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await request(makeApp())
      .delete(`${URL}/${encodeURIComponent("tok with/slash")}`)
      .set("Authorization", TOKEN);

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(String(calledUrl)).toMatch(/\/v1\/devices\/tok%20with%2Fslash$/);
  });

  it("returns 503 when the notifications-service hop fails", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await request(makeApp())
      .delete(`${URL}/fcm-abc`)
      .set("Authorization", TOKEN);

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});
