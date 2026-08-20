/**
 * `GET /api/v1/invites/details` — the unauthenticated preview card the web
 * interstitial renders. Guards the two rules that matter: only PUBLIC community
 * handles and GROUP tokens resolve, and a malformed target never reaches a
 * downstream service.
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";

const app = createApp(
  {} as unknown as MessagingClient,
  {} as unknown as MediaClient
);

const BASE = "/api/v1/invites/details";

describe("GET /api/v1/invites/details", () => {
  it("rejects an unknown type before any lookup", async () => {
    const res = await request(app).get(
      `${BASE}?slugOrToken=animefans&type=user`
    );
    expect(res.status).toBe(400);
  });

  it("rejects a handle that is not in the grammar", async () => {
    const res = await request(app).get(
      `${BASE}?slugOrToken=an!me&type=community`
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing target", async () => {
    const res = await request(app).get(`${BASE}?type=group`);
    expect(res.status).toBe(400);
  });

  it("404s an unresolvable community rather than leaking a generic 200", async () => {
    const res = await request(app).get(
      `${BASE}?slugOrToken=definitely_not_a_real_handle&type=community`
    );
    expect(res.status).toBe(404);
  });
});
