/**
 * Presigned upload URLs:
 *   POST /api/v1/communities/uploads/url
 *
 * This route delegates to `uploadService` (not `communityService`), so it is the
 * seam mocked here. The valid `type` enum comes from UPLOAD_TYPES (only
 * "COMMUNITY_AVATAR" today). contentLength is coerced from string → int.
 */
jest.mock("../../src/services/upload.service.js", () => ({
  uploadService: {
    createUploadUrl: jest.fn(),
  },
}));

import request from "supertest";

import { BadRequestError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { uploadService } from "../../src/services/upload.service.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const svc = uploadService as unknown as { createUploadUrl: jest.Mock };
const auth = () => bearer(makeAccessToken());
const SELF = "11111111-1111-4111-8111-111111111111";

describe("POST /api/v1/communities/uploads/url", () => {
  beforeEach(() => {
    svc.createUploadUrl.mockResolvedValue({
      uploadUrl: "https://minio.local/put?sig=abc",
      objectKey: "community/avatar/xyz.jpg",
      expiresIn: 900,
    });
  });

  it("returns 200 with the presigned URL; forwards ownerId from the token", async () => {
    const res = await request(app)
      .post("/api/v1/communities/uploads/url")
      .set(auth())
      .send({
        type: "COMMUNITY_AVATAR",
        contentType: "image/jpeg",
        contentLength: 1024,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.objectKey).toBe("community/avatar/xyz.jpg");
    expect(svc.createUploadUrl).toHaveBeenCalledWith({
      type: "COMMUNITY_AVATAR",
      contentType: "image/jpeg",
      contentLength: 1024,
      ownerId: SELF,
    });
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/communities/uploads/url")
      .send({
        type: "COMMUNITY_AVATAR",
        contentType: "image/png",
        contentLength: 1,
      });
    expect(res.status).toBe(401);
    expect(svc.createUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token", async () => {
    const res = await request(app)
      .post("/api/v1/communities/uploads/url")
      .set(bearer(makeExpiredAccessToken()))
      .send({
        type: "COMMUNITY_AVATAR",
        contentType: "image/png",
        contentLength: 1,
      });
    expect(res.status).toBe(401);
  });

  it.each([
    ["missing type", { contentType: "image/png", contentLength: 1 }],
    [
      "invalid type enum",
      { type: "RANDOM", contentType: "image/png", contentLength: 1 },
    ],
    ["missing contentType", { type: "COMMUNITY_AVATAR", contentLength: 1 }],
    [
      "empty contentType",
      { type: "COMMUNITY_AVATAR", contentType: "", contentLength: 1 },
    ],
    [
      "missing contentLength",
      { type: "COMMUNITY_AVATAR", contentType: "image/png" },
    ],
    [
      "zero contentLength",
      { type: "COMMUNITY_AVATAR", contentType: "image/png", contentLength: 0 },
    ],
    [
      "negative contentLength",
      { type: "COMMUNITY_AVATAR", contentType: "image/png", contentLength: -5 },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/communities/uploads/url")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.createUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 400 when the service rejects the MIME / size (BadRequest)", async () => {
    svc.createUploadUrl.mockRejectedValue(
      new BadRequestError("COMMUNITY_IMAGE_INVALID_TYPE")
    );
    const res = await request(app)
      .post("/api/v1/communities/uploads/url")
      .set(auth())
      .send({
        type: "COMMUNITY_AVATAR",
        contentType: "application/zip",
        contentLength: 1024,
      });
    expect(res.status).toBe(400);
  });
});
