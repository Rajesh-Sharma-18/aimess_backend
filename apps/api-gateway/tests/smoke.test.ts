/**
 * Smoke test — proves the gateway's real Express app boots under the Jest
 * harness (env validated, every module in the `createApp` import graph loads,
 * no real infra/ESM-native lib touched) and serves its simplest public route.
 *
 * The gateway exports a `createApp(messagingClient)` FACTORY (no default `app`),
 * so we build the app with a stub MessagingClient — the gRPC runtime client and
 * Socket.IO both live only in `src/server.ts`, outside this graph.
 */
import request from "supertest";

import { createApp } from "../src/app.js";
import type { MessagingClient } from "../src/grpc/clients/messaging.client.js";

/** Minimal stub MessagingClient — `app.ts` never calls it during /health. */
const messagingStub = {} as unknown as MessagingClient;

const app = createApp(messagingStub);

describe("api-gateway smoke", () => {
  it("GET /health → 200 with the running envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "API Gateway Running",
    });
  });
});
