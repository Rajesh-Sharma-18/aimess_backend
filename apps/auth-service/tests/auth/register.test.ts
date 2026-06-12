/**
 * POST /api/auth/register — happy path, duplicate-account conflict, and the
 * full Zod validation matrix. Repository + token issuance are mocked; routing,
 * validation, controller and service logic all run for real.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByAccount: jest.fn(),
    createUser: jest.fn(),
  },
}));
jest.mock("../../src/lib/token.js", () => ({
  issueAuthTokens: jest.fn(),
}));

import request from "supertest";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { issueAuthTokens } from "../../src/lib/token.js";

const repo = authRepository as unknown as {
  findByAccount: jest.Mock;
  createUser: jest.Mock;
};
const issue = issueAuthTokens as unknown as jest.Mock;

const TOKENS = {
  accessToken: "access.jwt.token",
  refreshToken: "refresh-token-value",
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 604800,
};

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    repo.findByAccount.mockResolvedValue(null);
    repo.createUser.mockResolvedValue({
      id: "user-1",
      account: "johndoe",
      role: "USER",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    issue.mockResolvedValue({ tokens: TOKENS, sessionId: "sess-1" });
  });

  it("registers a new account → 201 with user + tokens", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ account: "johndoe", password: "Password123" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.account).toBe("johndoe");
    expect(res.body.data.tokens.accessToken).toBe(TOKENS.accessToken);
    expect(repo.createUser).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the account already exists", async () => {
    repo.findByAccount.mockResolvedValue({ id: "existing-user" });

    const res = await request(app)
      .post("/api/auth/register")
      .send({ account: "johndoe", password: "Password123" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ["missing password", { account: "johndoe" }],
    ["password too short", { account: "johndoe", password: "short" }],
    ["account too short", { account: "ab", password: "Password123" }],
    [
      "account with illegal characters",
      { account: "john doe!", password: "Password123" },
    ],
    ["missing account", { password: "Password123" }],
    ["empty body", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.createUser).not.toHaveBeenCalled();
  });
});
