/**
 * AUDIT-001 — an unmatched path must answer with the documented JSON envelope.
 *
 * Every route is mounted before the error handler, but nothing terminated the
 * chain, so an unmatched request fell through to Express's own `finalhandler`
 * and came back as an HTML body ("Cannot GET /api/v1/nope"). `errorHandler` was
 * never reached, because reaching it requires someone to call `next(err)`.
 *
 * A client that mistypes a route — or hits one that was removed — then gets HTML
 * where `{ success, message }` was promised, and its JSON parse blows up instead
 * of surfacing the actual problem.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);

describe("unrouted paths answer in the JSON error envelope", () => {
  it.each([
    ["GET", "/api/v1/definitely-not-a-route"],
    ["GET", "/api/v99/auth/login"],
    ["POST", "/nope"],
  ])("%s %s → 404 JSON, never HTML", async (method, path) => {
    const res = await (method === "POST"
      ? request(app).post(path)
      : request(app).get(path));

    expect(res.status).toBe(404);
    expect(res.type).toBe("application/json");
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
    // The Express default body — the thing this handler exists to prevent.
    expect(res.text).not.toContain("<pre>");
  });

  it("does not shadow a route that DOES exist", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
