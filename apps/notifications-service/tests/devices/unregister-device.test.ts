/**
 * DELETE /v1/devices/:token — unregister one of the caller's device tokens.
 *
 * Real path: JWT middleware → `unregisterDevice` controller → Zod params
 * validation → `deviceTokenService.unregisterDevice` → repository
 * `deleteByUserAndToken(userId, token)`. The delete is SCOPED to the caller, so
 * a user can only drop their own token (IDOR-safe by construction).
 *
 * Controller contract (src/api/controllers/device.controller.ts):
 *   - success → 200 { success: true, removed: <boolean> }
 *     (removed = repo.deleteByUserAndToken returned a count > 0)
 *   - params zod failure → 400 { success: false, message }
 *   - repo throw → 500 { success: false, message: "Failed to unregister device" }
 *   - auth failure → 401
 *
 * NOTE: the token travels in the URL path; an empty `:token` segment makes
 * Express match DELETE /v1/devices/ (no route) → 404, not the 400 zod branch.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    upsert: jest.fn(),
    findTokensByUserId: jest.fn(),
    deleteByToken: jest.fn(),
    deleteByUserAndToken: jest.fn(),
  },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import {
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
  bearer,
  TEST_USER_ID,
} from "../helpers/auth.js";

const repo = deviceTokenRepository as unknown as Record<string, jest.Mock>;

const TOKEN = "fcm-token-to-delete";

describe("DELETE /v1/devices/:token", () => {
  beforeEach(() => {
    repo.deleteByUserAndToken.mockResolvedValue(1);
  });

  // --- POSITIVE -------------------------------------------------------------
  it("removes an owned token → 200 { removed: true } scoped to the caller", async () => {
    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(repo.deleteByUserAndToken).toHaveBeenCalledTimes(1);
    expect(repo.deleteByUserAndToken).toHaveBeenCalledWith(TEST_USER_ID, TOKEN);
  });

  it("returns removed:false when nothing matched (already gone / not owned)", async () => {
    repo.deleteByUserAndToken.mockResolvedValue(0);

    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: false });
  });

  it("url-decodes a percent-encoded token before scoping the delete", async () => {
    const raw = "tok with/slash+special";
    const res = await request(app)
      .delete(`/v1/devices/${encodeURIComponent(raw)}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(repo.deleteByUserAndToken).toHaveBeenCalledWith(TEST_USER_ID, raw);
  });

  // --- NEGATIVE: not-found routing ------------------------------------------
  it("returns 404 when the :token segment is empty (no route match)", async () => {
    const res = await request(app)
      .delete("/v1/devices/")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(repo.deleteByUserAndToken).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: auth (401) -------------------------------------------------
  it("returns 401 when no Authorization header is sent", async () => {
    const res = await request(app).delete(`/v1/devices/${TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(repo.deleteByUserAndToken).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired access token", async () => {
    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set(bearer(makeExpiredAccessToken()));

    expect(res.status).toBe(401);
    expect(repo.deleteByUserAndToken).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged token (wrong signing secret)", async () => {
    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set(bearer(makeForgedAccessToken()));

    expect(res.status).toBe(401);
    expect(repo.deleteByUserAndToken).not.toHaveBeenCalled();
  });

  it("returns 401 for a non-Bearer Authorization scheme", async () => {
    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set({ Authorization: `Basic ${makeAccessToken()}` });

    expect(res.status).toBe(401);
    expect(repo.deleteByUserAndToken).not.toHaveBeenCalled();
  });

  // --- NEGATIVE: downstream failure (500) -----------------------------------
  it("returns 500 when the repository throws", async () => {
    repo.deleteByUserAndToken.mockRejectedValue(new Error("mongo down"));

    const res = await request(app)
      .delete(`/v1/devices/${TOKEN}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Failed to unregister device");
  });

  // --- SECURITY: IDOR -------------------------------------------------------
  it("can only delete the CALLER's token — userId comes from the JWT, not the URL (IDOR guard)", async () => {
    const attackerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // The attacker targets a token they don't own; the delete is still scoped
    // to THEIR id, so deleteByUserAndToken matches nothing.
    repo.deleteByUserAndToken.mockResolvedValue(0);

    const res = await request(app)
      .delete(`/v1/devices/${"victim-owned-token"}`)
      .set(bearer(makeAccessToken({ userId: attackerId })));

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(false);
    // Crucially the repository is called with the attacker's own id, never a
    // victim's, so the row owned by another user is untouched.
    expect(repo.deleteByUserAndToken).toHaveBeenCalledWith(
      attackerId,
      "victim-owned-token"
    );
  });

  it("safely handles an injection-shaped token in the path (treated as a literal string)", async () => {
    const evil = encodeURIComponent('{"$gt":""}');
    repo.deleteByUserAndToken.mockResolvedValue(0);

    const res = await request(app)
      .delete(`/v1/devices/${evil}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(repo.deleteByUserAndToken).toHaveBeenCalledWith(
      TEST_USER_ID,
      '{"$gt":""}'
    );
  });
});
