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
import { signupProof } from "../helpers/solve-signup-challenge.js";

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
      .send({
        account: "johndoe",
        password: "Correct-Horse-Battery-7",
        proof: signupProof(),
      });

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
      .send({
        account: "johndoe",
        password: "Correct-Horse-Battery-7",
        proof: signupProof(),
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it.each(["Rajesh_Sharma", "RAJESH_SHARMA", "rAjEsH_sHaRmA", "  Rajesh_Sharma  "])(
    "canonicalizes %j to lowercase before the lookup and the insert",
    async (account) => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ account, password: "Correct-Horse-Battery-7", proof: signupProof() });

      expect(res.status).toBe(201);
      expect(repo.findByAccount).toHaveBeenCalledWith("rajesh_sharma");
      expect(repo.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ account: "rajesh_sharma" })
      );
    }
  );

  // The lost race: both requests passed findByAccount, the DB's case-insensitive
  // unique index rejected the second. Through the pg adapter the violated column
  // is only on driverAdapterError — it must still read as an ACCOUNT clash.
  it("maps a unique violation on lower(account) to 409 AUTH_ACCOUNT_TAKEN", async () => {
    repo.createUser.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        name: "PrismaClientKnownRequestError",
        code: "P2002",
        meta: {
          modelName: "AuthUser",
          driverAdapterError: {
            cause: { constraint: { fields: ["lower(account"] } },
          },
        },
      })
    );

    const res = await request(app)
      .post("/api/auth/register")
      .send({ account: "RAJESH_SHARMA", password: "Correct-Horse-Battery-7", proof: signupProof() });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("AUTH_ACCOUNT_TAKEN");
    expect(JSON.stringify(res.body)).not.toContain("lower(account");
  });

  it.each([
    ["missing password", { account: "johndoe" }],
    ["password too short", { account: "johndoe", password: "short" }],
    [
      "account too short",
      { account: "ab", password: "Correct-Horse-Battery-7" },
    ],
    [
      "account with illegal characters",
      { account: "john doe!", password: "Correct-Horse-Battery-7" },
    ],
    ["missing account", { password: "Correct-Horse-Battery-7" }],
    ["empty body", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/register")
      // A valid proof, so each case still fails for the reason it names rather
      // than for the missing challenge.
      .send({ ...body, proof: signupProof() });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  /**
   * AIM-58. Registration needed no verified contact detail and no bot
   * resistance of any kind: ten thousand accounts cost ten thousand HTTP
   * requests. Rate limiting bounds one address and does nothing about a proxy
   * pool, so account creation now costs the caller CPU it cannot amortise.
   */
  describe("proof of work", () => {
    it("refuses a registration carrying no proof", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ account: "johndoe", password: "Correct-Horse-Battery-7" });

      expect(res.status).toBe(400);
      expect(repo.createUser).not.toHaveBeenCalled();
    });

    it("refuses a registration whose proof is unsolved", async () => {
      const { challenge } = signupProof();

      const res = await request(app)
        .post("/api/auth/register")
        .send({
          account: "johndoe",
          password: "Correct-Horse-Battery-7",
          proof: { challenge, solution: "not-a-solution" },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("AUTH_CHALLENGE_INVALID");
      expect(repo.createUser).not.toHaveBeenCalled();
    });

    it("refuses to let one solved proof create a second account", async () => {
      // Without single-use enforcement the work is paid once and replayed for
      // the rest of the namespace, which makes the control decorative.
      const proof = signupProof();

      const first = await request(app)
        .post("/api/auth/register")
        .send({
          account: "johndoe",
          password: "Correct-Horse-Battery-7",
          proof,
        });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/auth/register")
        .send({
          account: "janedoe",
          password: "Correct-Horse-Battery-7",
          proof,
        });

      expect(second.status).toBe(400);
      expect(second.body.error?.code).toBe("AUTH_CHALLENGE_ALREADY_USED");
      expect(repo.createUser).toHaveBeenCalledTimes(1);
    });
  });
});
