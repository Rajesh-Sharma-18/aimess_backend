/**
 * POST /api/v1/media/upload-url
 *
 * Mocks only `createUploadUrl` (the S3 presign call). All validators
 * (`assertAllowedMime`, `assertFileSize`) run for real so the 415/400 branches
 * are exercised via genuine StorageValidationErrors.
 */
jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    createUploadUrl: jest.fn(async (params: any) => {
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
        uploadUrl: "https://minio.test/presigned-put",
        objectKey,
        uploadExpiresIn: params.expiresIn,
        maxBytes: params.def.maxBytes,
        headers: { "Content-Type": params.contentType },
      };
    }),
    // Resolve-on-read: the service presigns a GET for the minted key so the
    // upload-url response carries an immediately-usable downloadUrl.
    toMediaObject: jest.fn(async (input: any) => ({
      mediaId: input.mediaId ?? null,
      fileId: "test-file-id",
      objectKey: input.stored,
      fileName: null,
      contentType: null,
      size: null,
      downloadUrl: "https://minio.test/presigned-get",
      downloadUrlExpiresIn: null,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    })),
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

describe("POST /api/v1/media/upload-url", () => {
  it("200: valid USER_AVATAR upload returns upload envelope", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "USER_AVATAR",
        contentType: "image/png",
        contentLength: 1024,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.uploadUrl).toBe("https://minio.test/presigned-put");
    expect(typeof res.body.data.objectKey).toBe("string");
    expect(res.body.data.objectKey).toMatch(/^avatars\//);
    expect(res.body.data.media).toMatchObject({
      mediaId: "mock-media-id",
      objectKey: expect.any(String),
      uploadUrl: expect.any(String),
      uploadUrlExpiresIn: expect.any(Number),
      uploadHeaders: expect.objectContaining({ "Content-Type": "image/png" }),
    });
    // Resolve-on-read: a ready download URL is returned alongside the upload URL.
    expect(res.body.data.media.downloadUrl).toBe(
      "https://minio.test/presigned-get"
    );
    expect(typeof res.body.data.media.downloadUrl).toBe("string");
    expect(res.body.data.media.uploadUrl).toBe(
      "https://minio.test/presigned-put"
    );
    expect(res.body.data.media.downloadUrlExpiresIn).toBeNull();
    expect(typeof res.body.data.maxBytes).toBe("number");
    expect(typeof res.body.data.uploadExpiresIn).toBe("number");
  });

  it("200: valid CHAT_ATTACHMENT upload (image/jpeg)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType: "image/jpeg",
        contentLength: 2048,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.objectKey).toMatch(/^chat-uploads\//);
  });

  it("200: valid GROUP_AVATAR upload (image/webp)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "GROUP_AVATAR",
        contentType: "image/webp",
        contentLength: 102400,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.objectKey).toMatch(/^group-avatars\//);
  });

  it("200: valid GROUP_CHAT_ATTACHMENT upload (video/mp4)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "GROUP_CHAT_ATTACHMENT",
        contentType: "video/mp4",
        contentLength: 1048576,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.objectKey).toMatch(/^group-chat-uploads\//);
  });

  it("200: CHAT_ATTACHMENT accepts video/webm (newly enabled)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType: "video/webm",
        contentLength: 2048,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.objectKey).toMatch(/\.webm$/);
  });

  it("200: CHAT_ATTACHMENT accepts audio/flac (newly enabled)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType: "audio/flac",
        contentLength: 2048,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.objectKey).toMatch(/\.flac$/);
  });

  it("200: CHAT_ATTACHMENT accepts xlsx (newly enabled office type)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentLength: 2048,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.objectKey).toMatch(/\.xlsx$/);
  });

  it("200: CHAT_ATTACHMENT accepts text/csv", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType: "text/csv",
        contentLength: 2048,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.objectKey).toMatch(/\.csv$/);
  });

  it("415: CHAT_ATTACHMENT still rejects an unlisted executable type", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "CHAT_ATTACHMENT",
        contentType: "application/x-msdownload",
        contentLength: 2048,
      });

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
  });

  it("415: unsupported type for GROUP_AVATAR (application/pdf)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "GROUP_AVATAR",
        contentType: "application/pdf",
        contentLength: 1024,
      });

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
  });

  it("400: missing category", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({ contentType: "image/png", contentLength: 1024 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: invalid category value", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "BANNER",
        contentType: "image/png",
        contentLength: 1024,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: missing contentType", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({ category: "USER_AVATAR", contentLength: 1024 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: file exceeds USER_AVATAR max (5 MB cap + 1 byte)", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "USER_AVATAR",
        contentType: "image/png",
        contentLength: 5 * 1024 * 1024 + 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("415: unsupported content type for USER_AVATAR", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(auth())
      .send({
        category: "USER_AVATAR",
        contentType: "application/zip",
        contentLength: 1024,
      });

    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
  });

  it("401: no token", async () => {
    const res = await request(app).post("/api/v1/media/upload-url").send({
      category: "USER_AVATAR",
      contentType: "image/png",
      contentLength: 1024,
    });

    expect(res.status).toBe(401);
  });

  it("401: expired token", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(bearer(makeExpiredAccessToken()))
      .send({
        category: "USER_AVATAR",
        contentType: "image/png",
        contentLength: 1024,
      });

    expect(res.status).toBe(401);
  });

  it("401: forged token", async () => {
    const res = await request(app)
      .post("/api/v1/media/upload-url")
      .set(bearer(makeForgedAccessToken()))
      .send({
        category: "USER_AVATAR",
        contentType: "image/png",
        contentLength: 1024,
      });

    expect(res.status).toBe(401);
  });
});
