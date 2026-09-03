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
import { signupProof } from "../helpers/solve-signup-challenge.js";

const repo = authRepository as unknown as { findByAccount: jest.Mock };

describe("POST /api/auth/accounts/validate", () => {
  beforeEach(() => {
    repo.findByAccount.mockResolvedValue(null);
  });

  it("returns 200 + available:true when the account is free", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "johndoe", proof: signupProof() });

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
      .send({ account: "johndoe", proof: signupProof() });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("trims surrounding whitespace before checking availability", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "  johndoe  ", proof: signupProof() });

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
      // A valid proof, so each case still fails for the reason it names.
      .send({ ...body, proof: signupProof() });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  it("accepts the boundary lengths (3 and 32 chars)", async () => {
    const min = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "abc", proof: signupProof() });
    expect(min.status).toBe(200);

    const max = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "a".repeat(32), proof: signupProof() });
    expect(max.status).toBe(200);
  });

  it("safely rejects a NoSQL-injection-shaped object payload (not a string)", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: { $ne: null }, proof: signupProof() });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  /**
   * AIM-31. This endpoint is an availability oracle by design — a signup form
   * has to say "taken" while you type — and it answered 409 vs 200 for free,
   * unthrottled, which enumerates the entire handle namespace. Enumerated
   * handles are the input to targeted credential stuffing against /login.
   *
   * The oracle is priced rather than removed: each probe now costs the caller a
   * single-use proof of work on their own hardware, which no proxy pool can
   * spread around.
   */
  describe("enumeration cost", () => {
    it("refuses a probe carrying no proof", async () => {
      const res = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "johndoe" });

      expect(res.status).toBe(400);
      expect(repo.findByAccount).not.toHaveBeenCalled();
    });

    it("refuses a probe whose proof is unsolved", async () => {
      const { challenge } = signupProof();

      const res = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "johndoe", proof: { challenge, solution: "0" } });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("AUTH_CHALLENGE_INVALID");
      expect(repo.findByAccount).not.toHaveBeenCalled();
    });

    it("charges for every handle tested, not just the first", async () => {
      // Replaying one solved proof across the namespace would make the cost a
      // one-off and the control decorative.
      const proof = signupProof();

      const first = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "johndoe", proof });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/api/auth/accounts/validate")
        .send({ account: "janedoe", proof });

      expect(second.status).toBe(400);
      expect(second.body.error?.code).toBe("AUTH_CHALLENGE_ALREADY_USED");
      expect(repo.findByAccount).toHaveBeenCalledTimes(1);
    });
  });
});
