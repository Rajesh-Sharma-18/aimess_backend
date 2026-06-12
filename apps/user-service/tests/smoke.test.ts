/**
 * Smoke test — proves the real Express app boots under the Jest harness with all
 * I/O seams mocked (no Postgres, Redis, RabbitMQ, MinIO or gRPC touched), and
 * that the public health route responds. If this is green, the harness wiring
 * (env + global-mocks) is sound for the rest of the user-service suite.
 *
 * Note: user-service exports the app as a NAMED export `app` (not default).
 */
import request from "supertest";

import { app } from "../src/app.js";

describe("smoke: user-service boots under harness", () => {
  it("GET /health → 200 with service identity envelope", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      service: "user-service",
      environment: "test",
    });
  });
});
