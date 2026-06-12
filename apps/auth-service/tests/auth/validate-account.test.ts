/**
 * POST /api/auth/accounts/validate — account-availability check. Real Zod
 * validation + service run; only the repository is mocked. Available → 200,
 * taken → 409, malformed account → 400.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccount: jest.fn(),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";

const repo = authRepository as unknown as { findByAccount: jest.Mock };

describe("POST /api/auth/accounts/validate", () => {
  beforeEach(() => {
    repo.findByAccount.mockResolvedValue(null);
  });

  it("returns 200 + available:true when the account is free", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.account).toBe("johndoe");
    expect(repo.findByAccount).toHaveBeenCalledWith("johndoe");
  });

  it("returns 409 when the account is already taken", async () => {
    repo.findByAccount.mockResolvedValue({ id: "existing-user" });

    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("trims surrounding whitespace before checking availability", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "  johndoe  " });

    expect(res.status).toBe(200);
    expect(repo.findByAccount).toHaveBeenCalledWith("johndoe");
  });

  it.each([
    ["missing account", {}],
    ["empty account", { account: "" }],
    ["account too short", { account: "ab" }],
    ["account too long (33 chars)", { account: "a".repeat(33) }],
    ["illegal space", { account: "john doe" }],
    ["illegal symbol", { account: "john@doe" }],
    ["wrong type (number)", { account: 12345 }],
    ["null account", { account: null }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  it("accepts the boundary lengths (3 and 32 chars)", async () => {
    const min = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "abc" });
    expect(min.status).toBe(200);

    const max = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "a".repeat(32) });
    expect(max.status).toBe(200);
  });

  it("safely rejects a NoSQL-injection-shaped object payload (not a string)", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: { $ne: null } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });
});
