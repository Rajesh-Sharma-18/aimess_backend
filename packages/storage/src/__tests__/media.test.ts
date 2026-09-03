/**
 * Unit tests for the shared media layer pure logic. No infra needed — the
 * MinIO/S3 client is stubbed where a strategy is required. Run via
 * `tsx --test "src/**\/*.test.ts"` (matches the backoffice-service convention).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStorageClient } from "../client.js";
import { buildUploadMediaObject, toMediaObject } from "../media-object.js";
import {
  createMediaUrlStrategy,
  type MediaUrlStrategy,
} from "../media-url-strategy.js";
import {
  parseFileMetaFromObjectKey,
  parseObjectKeyFromStored,
} from "../object-key-parse.js";
import type { UploadUrlResult } from "../upload.js";

const AVATAR_OPTS = { prefixes: ["avatars"], bucket: "user-media" };

/** Strategy stub returning a fixed url + expiresIn (no infra). */
function fixedStrategy(
  url = "https://signed.example/file?sig=abc",
  expiresIn: number | null = 600
): MediaUrlStrategy {
  return {
    async resolveDownloadUrl() {
      return { url, expiresIn };
    },
  };
}

/** Strategy stub that always throws (download-resolution failure path). */
function throwingStrategy(): MediaUrlStrategy {
  return {
    async resolveDownloadUrl() {
      throw new Error("presign blew up");
    },
  };
}

describe("parseObjectKeyFromStored", () => {
  it("(a) passes through a bare key with a matching prefix", () => {
    assert.equal(
      parseObjectKeyFromStored("avatars/uid/file.jpg", AVATAR_OPTS),
      "avatars/uid/file.jpg"
    );
  });

  it("(b) strips a legacy full MinIO URL down to the object key", () => {
    assert.equal(
      parseObjectKeyFromStored(
        "http://host/user-media/avatars/uid/file.jpg",
        AVATAR_OPTS
      ),
      "avatars/uid/file.jpg"
    );
  });

  it("(c) marker-scans when the bucket prefix is absent but /avatars/ present", () => {
    assert.equal(
      parseObjectKeyFromStored(
        "http://host/some/other/path/avatars/uid/file.jpg",
        AVATAR_OPTS
      ),
      "avatars/uid/file.jpg"
    );
  });

  it("(d) returns null for an external DiceBear URL with no matching prefix", () => {
    assert.equal(
      parseObjectKeyFromStored(
        "https://api.dicebear.com/7.x/identicon/svg?seed=bob",
        AVATAR_OPTS
      ),
      null
    );
  });

  it("(e) returns null for null and empty input", () => {
    assert.equal(parseObjectKeyFromStored(null, AVATAR_OPTS), null);
    assert.equal(parseObjectKeyFromStored(undefined, AVATAR_OPTS), null);
    assert.equal(parseObjectKeyFromStored("", AVATAR_OPTS), null);
  });

  it("(f) returns null for non-URL garbage", () => {
    assert.equal(
      parseObjectKeyFromStored("not a url at all !!!", AVATAR_OPTS),
      null
    );
  });
});

describe("parseFileMetaFromObjectKey", () => {
  it("(a) splits basename into fileId + lowercased ext", () => {
    assert.deepEqual(parseFileMetaFromObjectKey("avatars/uid/abc.jpg"), {
      fileId: "abc",
      ext: "jpg",
    });
  });

  it("(b) returns basename as fileId and null ext when there is no extension", () => {
    assert.deepEqual(parseFileMetaFromObjectKey("avatars/uid/abc"), {
      fileId: "abc",
      ext: null,
    });
  });

  it("(c) returns all-null for null input", () => {
    assert.deepEqual(parseFileMetaFromObjectKey(null), {
      fileId: null,
      ext: null,
    });
  });
});

describe("toMediaObject", () => {
  it("(a) resolves a stored object key into a populated download MediaObject", async () => {
    const result = await toMediaObject({
      bucket: "user-media",
      stored: "avatars/uid/abc.jpg",
      prefixes: ["avatars"],
      strategy: fixedStrategy(),
      fileName: "abc.jpg",
      contentType: "image/jpeg",
      size: 1234,
    });

    assert.equal(result.objectKey, "avatars/uid/abc.jpg");
    assert.equal(result.fileId, "abc");
    assert.equal(result.mediaId, null);
    assert.equal(result.downloadUrl, "https://signed.example/file?sig=abc");
    assert.equal(result.downloadUrlExpiresIn, 600);
    assert.equal(result.fileName, "abc.jpg");
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(result.size, 1234);
    // upload half null
    assert.equal(result.uploadUrl, null);
    assert.equal(result.uploadUrlExpiresIn, null);
  });

  it("(a2) stamps the supplied mediaId through, independent of objectKey/url", async () => {
    const result = await toMediaObject({
      bucket: "user-media",
      stored: "avatars/uid/abc.jpg",
      prefixes: ["avatars"],
      strategy: fixedStrategy(),
      mediaId: "registry-id-1",
    });

    assert.equal(result.mediaId, "registry-id-1");
    assert.equal(result.objectKey, "avatars/uid/abc.jpg");
  });

  it("(b) returns an all-null inner MediaObject when stored is null", async () => {
    const result = await toMediaObject({
      bucket: "user-media",
      stored: null,
      prefixes: ["avatars"],
      strategy: fixedStrategy(),
    });

    assert.equal(result.fileId, null);
    assert.equal(result.mediaId, null);
    assert.equal(result.objectKey, null);
    assert.equal(result.fileName, null);
    assert.equal(result.contentType, null);
    assert.equal(result.size, null);
    assert.equal(result.downloadUrl, null);
    assert.equal(result.downloadUrlExpiresIn, null);
    assert.equal(result.uploadUrl, null);
    assert.equal(result.uploadUrlExpiresIn, null);
  });

  it("(c) passes an external http URL through as the download URL", async () => {
    const ext = "https://api.dicebear.com/7.x/identicon/svg?seed=bob";
    const result = await toMediaObject({
      bucket: "user-media",
      stored: ext,
      prefixes: ["avatars"],
      strategy: fixedStrategy(),
    });

    assert.equal(result.downloadUrl, ext);
    assert.equal(result.objectKey, null);
    assert.equal(result.fileId, null);
    assert.equal(result.downloadUrlExpiresIn, null);
  });

  it("(d) swallows a strategy throw — downloadUrl null, no exception", async () => {
    const result = await toMediaObject({
      bucket: "user-media",
      stored: "avatars/uid/abc.jpg",
      prefixes: ["avatars"],
      strategy: throwingStrategy(),
    });

    assert.equal(result.objectKey, "avatars/uid/abc.jpg");
    assert.equal(result.fileId, "abc");
    assert.equal(result.downloadUrl, null);
    assert.equal(result.downloadUrlExpiresIn, null);
  });

  it("(e) does not call the strategy when resolveDownload is false", async () => {
    let called = false;
    const spyStrategy: MediaUrlStrategy = {
      async resolveDownloadUrl() {
        called = true;
        return { url: "should-not-be-used", expiresIn: 1 };
      },
    };

    const result = await toMediaObject({
      bucket: "user-media",
      stored: "avatars/uid/abc.jpg",
      prefixes: ["avatars"],
      strategy: spyStrategy,
      resolveDownload: false,
    });

    assert.equal(called, false);
    assert.equal(result.objectKey, "avatars/uid/abc.jpg");
    assert.equal(result.downloadUrl, null);
  });
});

describe("buildUploadMediaObject", () => {
  it("maps an UploadUrlResult into an upload MediaObject (download half null)", () => {
    const uploadResult: UploadUrlResult = {
      uploadUrl: "https://signed.example/put?sig=xyz",
      objectKey: "avatars/uid/x.png",
      uploadExpiresIn: 900,
      maxBytes: 5_000_000,
      // Content-Length is now signed into the presigned PUT, so it is part of
      // the headers the client must send (AIM-12).
      headers: { "Content-Type": "image/png", "Content-Length": "1024" },
    };

    const result = buildUploadMediaObject({
      result: uploadResult,
      contentType: "image/png",
      fileName: "x.png",
    });

    assert.equal(result.uploadUrl, "https://signed.example/put?sig=xyz");
    assert.equal(result.uploadUrlExpiresIn, 900);
    assert.deepEqual(result.uploadHeaders, {
      "Content-Type": "image/png",
      "Content-Length": "1024",
    });
    assert.equal(result.objectKey, "avatars/uid/x.png");
    assert.equal(result.fileId, "x");
    assert.equal(result.mediaId, null);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.fileName, "x.png");
    // download half null
    assert.equal(result.downloadUrl, null);
    assert.equal(result.downloadUrlExpiresIn, null);
  });

  it("stamps the supplied mediaId through", () => {
    const uploadResult: UploadUrlResult = {
      uploadUrl: "https://signed.example/put?sig=xyz",
      objectKey: "avatars/uid/x.png",
      uploadExpiresIn: 900,
      maxBytes: 5_000_000,
      // Content-Length is now signed into the presigned PUT, so it is part of
      // the headers the client must send (AIM-12).
      headers: { "Content-Type": "image/png", "Content-Length": "1024" },
    };

    const result = buildUploadMediaObject({
      result: uploadResult,
      contentType: "image/png",
      mediaId: "registry-id-2",
    });

    assert.equal(result.mediaId, "registry-id-2");
  });
});

describe("createMediaUrlStrategy", () => {
  it("returns a CDN URL with null expiresIn when cdnBaseUrl is set (no presign)", async () => {
    const client = createStorageClient({
      endpoint: "http://localhost:9000",
      accessKey: "key",
      secretKey: "secret",
      region: "us-east-1",
    });

    const strategy = createMediaUrlStrategy({
      client,
      defaultViewExpiresIn: 600,
      cdnBaseUrl: "https://cdn.example.com/",
    });

    const resolved = await strategy.resolveDownloadUrl(
      "user-media",
      "avatars/uid/abc.jpg"
    );

    assert.equal(resolved.url, "https://cdn.example.com/avatars/uid/abc.jpg");
    assert.equal(resolved.expiresIn, null);
  });

  it("falls back to presigning when cdnBaseUrl is null", async () => {
    const client = createStorageClient({
      endpoint: "http://localhost:9000",
      accessKey: "key",
      secretKey: "secret",
      region: "us-east-1",
    });

    const strategy = createMediaUrlStrategy({
      client,
      defaultViewExpiresIn: 600,
      cdnBaseUrl: null,
    });

    const resolved = await strategy.resolveDownloadUrl(
      "user-media",
      "avatars/uid/abc.jpg"
    );

    // It actually signed: a presigned GET URL pointing at the object,
    // and carries the configured expiry (not the CDN's null).
    assert.equal(resolved.expiresIn, 600);
    assert.match(resolved.url, /^http:\/\/localhost:9000\//);
    assert.match(resolved.url, /avatars\/uid\/abc\.jpg/);
    assert.match(resolved.url, /X-Amz-Signature=/);
  });
});
