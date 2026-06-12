/**
 * Integration tests — media presign endpoints.
 * Routes (apps/chat-service/src/api/routes/media.routes.ts):
 *   POST /api/chat/media/upload-url    (authenticate + upload rate-limit)
 *   POST /api/chat/media/download-url  (authenticate + download rate-limit)
 *
 * The controller imports @aimess/storage directly (native MinIO client), so we
 * mock the package here — the preset only stubs src/config/storage.js. The
 * controller's own Zod guards (filename/contentType, objectKey) and the
 * chat-uploads/ prefix check are exercised for real.
 */

// Mock @aimess/storage BEFORE importing the app factory (hoisted by ts-jest).
jest.mock("@aimess/storage", () => ({
  createPresignedUploadUrl: jest.fn(async () => "http://minio/upload-url"),
  createPresignedViewUrl: jest.fn(async () => "http://minio/download-url"),
  buildObjectKey: jest.fn(
    ({
      prefix,
      ownerId,
      ext,
    }: {
      prefix: string;
      ownerId: string;
      ext: string;
    }) => `${prefix}/${ownerId}/file123.${ext}`
  ),
  parseFileMetaFromObjectKey: jest.fn(() => ({ fileId: "file123" })),
  toMediaObject: jest.fn(async () => ({ fileId: "file123", objectKey: "k" })),
  ensureBuckets: jest.fn(async () => undefined),
  // Real ownership predicate (the controller uses this to close the H7 IDOR).
  assertObjectKeyOwnedBy: jest.fn(
    (objectKey: string, prefix: string, ownerId: string) =>
      objectKey.startsWith(`${prefix}/${ownerId}/`) && !objectKey.includes("..")
  ),
}));

import request from "supertest";

import { buildApp } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
} from "../helpers/auth.js";

let app: import("express").Express;

beforeEach(() => {
  ({ app } = buildApp());
});

describe("POST /api/chat/media/upload-url", () => {
  it("POSITIVE: returns a presigned upload url + objectKey for an allowed mime", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .set(bearer(makeAccessToken()))
      .send({ filename: "pic.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.uploadUrl).toBe("http://minio/upload-url");
    expect(res.body.data.objectKey).toContain("chat-uploads/");
    expect(res.body.data.contentType).toBe("image/jpeg");
  });

  it("NEGATIVE: 400 for a disallowed content type (not in the registry)", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .set(bearer(makeAccessToken()))
      .send({ filename: "evil.exe", contentType: "application/x-msdownload" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("NEGATIVE: 400 when filename is missing", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .set(bearer(makeAccessToken()))
      .send({ contentType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("EDGE: 400 for an over-long filename (>255 chars)", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .set(bearer(makeAccessToken()))
      .send({ filename: "a".repeat(256) + ".png", contentType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .send({ filename: "pic.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for a forged token", async () => {
    const res = await request(app)
      .post("/api/chat/media/upload-url")
      .set(bearer(makeForgedAccessToken()))
      .send({ filename: "pic.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/chat/media/download-url", () => {
  it("POSITIVE: returns a presigned view url for a key the caller owns", async () => {
    const res = await request(app)
      .post("/api/chat/media/download-url")
      .set(bearer(makeAccessToken()))
      .send({ objectKey: `chat-uploads/${TEST_USER_ID}/file123.jpg` });

    expect(res.status).toBe(200);
    expect(res.body.data.downloadUrl).toBe("http://minio/download-url");
  });

  // AUDIT H7 — prefix-only auth let any user fetch another user's attachment.
  it("SECURITY: IDOR — 403 for a chat-uploads key owned by another user", async () => {
    const res = await request(app)
      .post("/api/chat/media/download-url")
      .set(bearer(makeAccessToken()))
      .send({ objectKey: "chat-uploads/another-user-id/file123.jpg" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("SECURITY: 400 rejects a key OUTSIDE the chat-uploads/ prefix (path-escape)", async () => {
    const res = await request(app)
      .post("/api/chat/media/download-url")
      .set(bearer(makeAccessToken()))
      .send({ objectKey: "avatars/secret/other-user.jpg" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("NEGATIVE: 400 when objectKey is missing", async () => {
    const res = await request(app)
      .post("/api/chat/media/download-url")
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post("/api/chat/media/download-url")
      .send({ objectKey: "chat-uploads/owner/file123.jpg" });
    expect(res.status).toBe(401);
  });
});
