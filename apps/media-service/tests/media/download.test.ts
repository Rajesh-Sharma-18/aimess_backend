/**
 * POST /api/v1/media/download-url
 *
 * Mocks `toMediaObject` (the S3 presign call) and `assertObjectKeyOwnedBy`
 * so IDOR enforcement is tested without live storage.
 */
jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    toMediaObject: jest.fn(async (input: any) => ({
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
    assertObjectKeyOwnedBy: jest.fn(
      (objectKey: string, prefix: string, ownerId: string) =>
        actual.assertObjectKeyOwnedBy(objectKey, prefix, ownerId)
    ),
  };
});

import request from "supertest";
import { app } from "../../src/app.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());

describe("POST /api/v1/media/download-url", () => {
  it("200: valid USER_AVATAR download", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({
        objectKey: "avatars/some-user-id/abc.png",
        category: "USER_AVATAR",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.downloadUrl).toBe("https://minio.test/presigned-get");
    expect(res.body.data.downloadUrlExpiresIn).toBeNull();
    expect(res.body.data.media).toBeDefined();
  });

  it("200: valid CHAT_ATTACHMENT download (own key)", async () => {
    const ownKey = `chat-uploads/${TEST_USER_ID}/file.mp4`;
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: ownKey, category: "CHAT_ATTACHMENT" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.downloadUrl).toBe("https://minio.test/presigned-get");
  });

  it("403: CHAT_ATTACHMENT IDOR — key owned by another user", async () => {
    const otherUserId = "99999999-9999-4999-8999-999999999999";
    const otherKey = `chat-uploads/${otherUserId}/file.mp4`;
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: otherKey, category: "CHAT_ATTACHMENT" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("400: missing objectKey", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ category: "USER_AVATAR" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: invalid category value", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: "avatars/x/y.png", category: "DOES_NOT_EXIST" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("200: declared category mismatch self-heals from the objectKey prefix", async () => {
    // The reported bug: client sent category CHAT_ATTACHMENT for a
    // community-chat-uploads/* key. The objectKey's own prefix is authoritative,
    // so the object resolves (as COMMUNITY_CHAT_ATTACHMENT) instead of returning
    // an all-null MediaObject with an empty downloadUrl.
    const key = `community-chat-uploads/${TEST_USER_ID}/file.mp4`;
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: key, category: "CHAT_ATTACHMENT" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.downloadUrl).toBe("https://minio.test/presigned-get");
    expect(res.body.data.media.objectKey).toBe(key);
  });

  it("403: objectKey prefix governs over a mismatched declared category (IDOR)", async () => {
    // A chat-uploads key owned by ANOTHER user, declared (wrongly) as
    // COMMUNITY_CHAT_ATTACHMENT, is recognized as CHAT_ATTACHMENT by its prefix
    // and rejected by the owner check — not masked as a generic 400.
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({
        objectKey: "chat-uploads/some-user/file.mp4",
        category: "COMMUNITY_CHAT_ATTACHMENT",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("200: GROUP_AVATAR download (no ownership check)", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({
        objectKey: "group-avatars/some-group-id/pic.png",
        category: "GROUP_AVATAR",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.downloadUrl).toBe("https://minio.test/presigned-get");
  });

  it("200: GROUP_CHAT_ATTACHMENT download with valid prefix", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({
        objectKey: "group-chat-uploads/alice/video.mp4",
        category: "GROUP_CHAT_ATTACHMENT",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.downloadUrl).toBe("https://minio.test/presigned-get");
  });

  it("403: GROUP_CHAT_ATTACHMENT declared but key is another user's chat-uploads key (IDOR)", async () => {
    // Prefix governs → resolved as CHAT_ATTACHMENT → owner check fails.
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({
        objectKey: "chat-uploads/some-user/file.mp4",
        category: "GROUP_CHAT_ATTACHMENT",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("401: no token", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .send({ objectKey: "avatars/x/y.png", category: "USER_AVATAR" });

    expect(res.status).toBe(401);
  });

  it("401: expired token", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(bearer(makeExpiredAccessToken()))
      .send({ objectKey: "avatars/x/y.png", category: "USER_AVATAR" });

    expect(res.status).toBe(401);
  });

  it("401: forged token", async () => {
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(bearer(makeForgedAccessToken()))
      .send({ objectKey: "avatars/x/y.png", category: "USER_AVATAR" });

    expect(res.status).toBe(401);
  });
});
