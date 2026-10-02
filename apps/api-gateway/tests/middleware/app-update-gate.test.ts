/**
 * Admin FORCE enforcement at the edge: refused clients get 426
 * APP_UPDATE_REQUIRED; everyone else, token refresh, and every failure pass.
 */
import express from "express";
import request from "supertest";

import { createAppUpdateGate } from "../../src/middleware/app-update-gate.js";

function appWith(refusal: () => Promise<unknown>) {
  const app = express();
  app.use(
    createAppUpdateGate({ refusal: refusal as never })
  );
  app.use((_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("app update gate", () => {
  it("refused client → 426 APP_UPDATE_REQUIRED", async () => {
    const res = await request(appWith(async () => ({ action: "FORCE" })))
      .get("/users/me")
      .set("x-platform", "android")
      .set("x-app-version", "1.0.0");

    expect(res.status).toBe(426);
    expect(res.body.code).toBe("APP_UPDATE_REQUIRED");
    expect(res.body.error.code).toBe("APP_UPDATE_REQUIRED");
  });

  it("allowed client passes through", async () => {
    const res = await request(appWith(async () => null)).get("/users/me");
    expect(res.status).toBe(200);
  });

  it("token refresh is never refused, so a forced user stays signed in", async () => {
    const refusal = jest.fn(async () => ({ action: "FORCE" }));
    const res = await request(appWith(refusal)).post("/auth/refresh");
    expect(res.status).toBe(200);
    expect(refusal).not.toHaveBeenCalled();
  });

  it("a policy error fails open", async () => {
    const res = await request(
      appWith(async () => {
        throw new Error("boom");
      })
    ).get("/users/me");
    expect(res.status).toBe(200);
  });
});
