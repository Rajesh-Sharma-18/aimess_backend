/**
 * GET /api/v1/webrtc/rtc-config — the gateway's only route that exercises the
 * injected gRPC `MessagingClient`. The real client lives only in `server.ts`;
 * `createApp(messagingClient)` takes it as a parameter, so each test injects a
 * stub whose `getRtcConfig()` resolves (happy path) or rejects (circuit-breaker
 * /downstream failure → graceful 503). Routing, the v1 mount, the asyncHandler,
 * and `ApiResponse` envelope all run for real.
 *
 * NOTE: this route is mounted BEFORE the proxied services, so it is reachable
 * without any downstream service being up.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const RTC = "/api/v1/webrtc/rtc-config";

/** Build an app whose messaging client returns the given getRtcConfig impl. */
function appWith(getRtcConfig: jest.Mock) {
  const client = { getRtcConfig } as unknown as MessagingClient;
  return { app: createApp(client), getRtcConfig };
}

const SAMPLE_RTC = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    {
      urls: ["turn:turn.example.com:3478"],
      username: "user",
      credential: "pass",
    },
  ],
};

describe("GET /api/v1/webrtc/rtc-config", () => {
  // --- POSITIVE -----------------------------------------------------------
  it("returns the RTC config from the messaging client → 200", async () => {
    const getRtcConfig = jest.fn(async () => ({ rtcConfig: SAMPLE_RTC }));
    const { app } = appWith(getRtcConfig);

    const res = await request(app).get(RTC);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "RTC configuration retrieved",
      data: SAMPLE_RTC,
    });
    expect(getRtcConfig).toHaveBeenCalledTimes(1);
  });

  it("forwards an empty iceServers list unchanged", async () => {
    const getRtcConfig = jest.fn(async () => ({
      rtcConfig: { iceServers: [] },
    }));
    const { app } = appWith(getRtcConfig);

    const res = await request(app).get(RTC);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ iceServers: [] });
  });

  // --- NEGATIVE: downstream failure ---------------------------------------
  it("gRPC client rejects (circuit open / service down) → 503 graceful", async () => {
    const getRtcConfig = jest.fn(async () => {
      throw new Error("Breaker is open");
    });
    const { app } = appWith(getRtcConfig);

    const res = await request(app).get(RTC);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: true, // ApiResponse always sets success:true; data is null
      message: "RTC service temporarily unavailable",
      data: null,
    });
  });

  it("gRPC timeout-shaped rejection → 503 (no leak of the raw error)", async () => {
    const getRtcConfig = jest.fn(async () => {
      const err = new Error("4 DEADLINE_EXCEEDED");
      throw err;
    });
    const { app } = appWith(getRtcConfig);

    const res = await request(app).get(RTC);

    expect(res.status).toBe(503);
    expect(res.body.message).toBe("RTC service temporarily unavailable");
    expect(res.body.message).not.toContain("DEADLINE");
  });

  // --- NEGATIVE: routing / method -----------------------------------------
  it("POST to rtc-config (wrong method) → 404 (no POST handler mounted)", async () => {
    const getRtcConfig = jest.fn();
    const { app } = appWith(getRtcConfig);

    const res = await request(app).post(RTC).send({});

    // No POST route under /webrtc; nothing downstream proxies it either.
    expect(res.status).toBe(404);
    expect(getRtcConfig).not.toHaveBeenCalled();
  });

  it("unknown webrtc subpath → 404", async () => {
    const getRtcConfig = jest.fn();
    const { app } = appWith(getRtcConfig);

    const res = await request(app).get("/api/v1/webrtc/does-not-exist");

    expect(res.status).toBe(404);
    expect(getRtcConfig).not.toHaveBeenCalled();
  });
});
