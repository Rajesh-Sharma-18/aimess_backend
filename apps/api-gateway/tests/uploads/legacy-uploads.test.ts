/**
 * Backward-compatible alias:
 *   POST /api/v1/users/uploads/url  ({ type: "AVATAR", ... })
 *     → forwarded to media-service POST /api/v1/media/upload-url
 *       (canonical { category: "USER_AVATAR", ... })
 *
 * The gateway→media hop is a server-side `fetch`, mocked here so no network is
 * needed. media-service does the JWT auth + ownerId derivation and returns the
 * SAME response shape, so the shim relays its status + body verbatim. Mounted
 * only when MEDIA_SERVICE_URL is set (provided by tests/setup/env.ts).
 */
import request from "supertest";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";

const URL = "/api/v1/users/uploads/url";
const TOKEN = "Bearer test.jwt.token";

function makeApp() {
  return createApp({} as unknown as MessagingClient);
}

const MEDIA_RESPONSE = {
  success: true,
  message: "Avatar upload URL created.",
  data: {
    uploadUrl: "https://minio.test/presigned-put",
    objectKey: "avatars/11111111-1111-4111-8111-111111111111/abc.png",
    uploadExpiresIn: 900,
    maxBytes: 5242880,
    headers: { "Content-Type": "image/png" },
    media: {
      objectKey: "avatars/11111111-1111-4111-8111-111111111111/abc.png",
      uploadUrl: "https://minio.test/presigned-put",
    },
  },
};

describe("POST /api/v1/users/uploads/url (alias → media-service)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("renames type:AVATAR→category:USER_AVATAR, forwards auth, relays 200 + identical body", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(MEDIA_RESPONSE),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .set("x-lang", "en")
      .send({ type: "AVATAR", contentType: "image/png", contentLength: 1024 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MEDIA_RESPONSE);
    expect(res.body.data.objectKey).toMatch(/^avatars\//);

    // forwarded to the centralized media endpoint with the renamed field + auth
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/api\/v1\/media\/upload-url$/);
    expect(JSON.parse(init.body as string)).toEqual({
      category: "USER_AVATAR",
      contentType: "image/png",
      contentLength: 1024,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(TOKEN);
    expect(headers["x-lang"]).toBe("en");
  });

  it("rejects a non-AVATAR type with 400 and never calls media-service", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ type: "BANNER", contentType: "image/png", contentLength: 1024 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays a 401 from media-service (unauthenticated upstream)", async () => {
    global.fetch = jest.fn(async () => ({
      status: 401,
      text: async () =>
        JSON.stringify({ success: false, message: "Unauthorized" }),
    })) as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ type: "AVATAR", contentType: "image/png", contentLength: 1024 });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 503 when the media-service hop fails", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await request(makeApp())
      .post(URL)
      .set("Authorization", TOKEN)
      .send({ type: "AVATAR", contentType: "image/png", contentLength: 1024 });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});
