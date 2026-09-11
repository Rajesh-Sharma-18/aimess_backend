/**
 * POST /api/auth/accounts/validate — step 1 of the two-step login form, and the
 * signup form's "is this handle free?" probe.
 *
 * It used to accept a username-shaped value ONLY, so an account whose owner
 * signs in with the email they linked in Settings could never leave that step:
 * the address failed Zod validation with 400 before any credential was checked,
 * which is what made "log in with my linked email" impossible on the web client
 * even though POST /login has always resolved an email identifier.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccount: jest.fn(),
    findByEmail: jest.fn(),
  },
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  repo.findByAccount.mockResolvedValue(null);
  repo.findByEmail.mockResolvedValue(null);
});

describe("POST /api/auth/accounts/validate", () => {
  it("resolves an email identifier against the profile email", async () => {
    repo.findByEmail.mockResolvedValue({ id: "user-1" });

    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "smileycreatures1@yopmail.com" });

    // 409 AUTH_ACCOUNT_TAKEN — which is what the login form reads as "this
    // account exists, show the password field".
    expect(res.status).toBe(409);
    expect(repo.findByEmail).toHaveBeenCalledWith(
      "smileycreatures1@yopmail.com"
    );
    expect(repo.findByAccount).not.toHaveBeenCalled();
  });

  it("lowercases an email identifier before looking it up", async () => {
    await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: " SmileyCreatures1@Yopmail.com " });

    expect(repo.findByEmail).toHaveBeenCalledWith(
      "smileycreatures1@yopmail.com"
    );
  });

  it("still resolves a username against the account name, case intact", async () => {
    repo.findByAccount.mockResolvedValue({ id: "user-1" });

    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "Smiley_Creatures" });

    expect(res.status).toBe(409);
    expect(repo.findByAccount).toHaveBeenCalledWith("Smiley_Creatures");
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it("reports an unknown email as available rather than rejecting it", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "nobody@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
  });

  it("still rejects a value that is neither a username nor an email", async () => {
    const res = await request(app)
      .post("/api/auth/accounts/validate")
      .send({ account: "not a handle!" });

    expect(res.status).toBe(400);
    expect(repo.findByAccount).not.toHaveBeenCalled();
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });
});
