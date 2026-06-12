/**
 * POST /api/v1/users/uploads/url — presigned avatar upload envelope.
 *
 * The upload service runs the REAL StorageValidationError → HTTP mapping and the
 * REAL @aimess/storage validators (`assertAllowedMime`, `assertFileSize`,
 * `buildUploadMediaObject`). We override only `createUploadUrl` — the one
 * function that would otherwise reach into a live S3 presigner — so it first
 * runs the genuine validators (preserving the 415 / 400 error branches) and
 * then returns a deterministic envelope with a fake presigned URL.
 *
 * (We cannot stub `createPresignedUploadUrl` alone: the real `createUploadUrl`
 * calls it through an internal `./presign.js` import that the package barrel
 * mock does not intercept.)
 */
jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    createUploadUrl: jest.fn(async (params: any) => {
      // Exercise the genuine validators so unsupported-type / too-large
      // payloads still throw the real StorageValidationError the service maps.
      actual.assertAllowedMime(
        params.contentType,
        Object.keys(params.def.allowedMime)
      );
      actual.assertFileSize(params.contentLength, params.def.maxBytes);

      const ext = params.def.allowedMime[params.contentType];
      const objectKey = actual.buildObjectKey({
        prefix: params.def.keyPrefix,
        ownerId: params.ownerId,
        ext,
      });
      return {
        uploadUrl: "https://minio.test/avatars/presigned-put",
        objectKey,
        uploadExpiresIn: params.expiresIn,
        maxBytes: params.def.maxBytes,
        headers: { "Content-Type": params.contentType },
      };
    }),
  };
});

import request from "supertest";

import { app } from "../../src/app.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());

const validBody = {
  type: "AVATAR",
  contentType: "image/png",
  contentLength: 1024,
};

describe("POST /api/v1/users/uploads/url", () => {
  it("creates a presigned avatar upload URL → 200", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(auth())
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.uploadUrl).toBe(
      "https://minio.test/avatars/presigned-put"
    );
    expect(typeof res.body.data.objectKey).toBe("string");
    expect(res.body.data.headers["Content-Type"]).toBe("image/png");
    expect(res.body.data.media).toBeDefined();
  });

  it("returns 415 for an unsupported content type", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(auth())
      .send({ ...validBody, contentType: "application/zip" });

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for a file larger than the avatar max", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(auth())
      // 5 MB default cap + 1 byte.
      .send({ ...validBody, contentLength: 5 * 1024 * 1024 + 1 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ["missing type", { contentType: "image/png", contentLength: 1024 }],
    [
      "invalid type enum",
      { type: "BANNER", contentType: "image/png", contentLength: 1024 },
    ],
    ["missing contentType", { type: "AVATAR", contentLength: 1024 }],
    [
      "empty contentType",
      { type: "AVATAR", contentType: "", contentLength: 1024 },
    ],
    ["missing contentLength", { type: "AVATAR", contentType: "image/png" }],
    [
      "zero contentLength",
      { type: "AVATAR", contentType: "image/png", contentLength: 0 },
    ],
    [
      "negative contentLength",
      { type: "AVATAR", contentType: "image/png", contentLength: -1 },
    ],
    [
      "non-numeric contentLength",
      { type: "AVATAR", contentType: "image/png", contentLength: "big" },
    ],
    ["empty body", {}],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired token", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(bearer(makeExpiredAccessToken()))
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .post("/api/v1/users/uploads/url")
      .set(bearer(makeForgedAccessToken()))
      .send(validBody);
    expect(res.status).toBe(401);
  });
});
