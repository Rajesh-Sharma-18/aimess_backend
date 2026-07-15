/**
 * Stable alias (spec phase 11/12 — "Linked Devices"):
 *   GET    /api/v1/users/linked-devices              → auth-service GET /api/auth/sessions
 *   DELETE /api/v1/users/linked-devices/{deviceId}   → auth-service DELETE /api/auth/sessions/{deviceId}
 *
 * The gateway→auth-service hop is a server-side `fetch`, mocked here (same
 * pattern as fcm-token-alias.test.ts) — no new business logic, just forwarding
 * to the existing sessions list/revoke endpoints.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const TOKEN = "Bearer test.jwt.token";

function makeApp() {
  return createApp({} as unknown as MessagingClient);
}

describe("GET /api/v1/users/linked-devices (alias → auth-service sessions)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards to auth-service GET /api/auth/sessions and relays the list verbatim", async () => {
    const upstreamBody = {
      success: true,
      data: {
        sessions: [{ sessionId: "s1", deviceName: "Pixel", isCurrent: true }],
      },
    };
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(upstreamBody),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .get("/api/v1/users/linked-devices")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(upstreamBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/api\/auth\/sessions$/);
    expect((init.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it("returns 503 when the auth-service hop fails", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await request(makeApp())
      .get("/api/v1/users/linked-devices")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});

describe("DELETE /api/v1/users/linked-devices/:deviceId (alias → auth-service sessions)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards to auth-service DELETE /api/auth/sessions/{deviceId}", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: null }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .delete("/api/v1/users/linked-devices/session-abc")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/api\/auth\/sessions\/session-abc$/);
    expect(init.method).toBe("DELETE");
  });

  it("relays a 404 from auth-service verbatim (device not found)", async () => {
    global.fetch = jest.fn(async () => ({
      status: 404,
      text: async () =>
        JSON.stringify({ success: false, message: "Not found" }),
    })) as unknown as typeof fetch;

    const res = await request(makeApp())
      .delete("/api/v1/users/linked-devices/ghost")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
