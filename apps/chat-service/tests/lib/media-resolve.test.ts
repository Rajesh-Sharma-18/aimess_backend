/**
 * Unit coverage for the resolve-on-read media boundary (src/lib/media-resolve).
 *
 * The @aimess/storage URL strategy is mocked at the config/storage seam so the
 * test is infra-free: it asserts (a) the correct BUCKET is inferred from each
 * stored key's prefix, (b) http(s) values and empties bypass signing, (c)
 * failures degrade to "" rather than throwing, and (d) batch/attachment helpers
 * dedupe and map correctly. Bucket names come from the test env defaults:
 * avatars→aimess-avatars, community→aimess-community, chat→aimess-chat-test.
 */

const resolveDownloadUrl = jest.fn();

jest.mock("../../src/config/storage.js", () => ({
  __esModule: true,
  mediaUrlStrategy: {
    resolveDownloadUrl: (bucket: string, key: string) =>
      resolveDownloadUrl(bucket, key),
  },
}));

import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  resolveContentFiles,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKey,
} from "../../src/lib/media-resolve.js";

const AVATARS = "aimess-avatars";
const COMMUNITY = "aimess-community";
const CHAT = "aimess-chat-test"; // MINIO_BUCKET in tests/setup/env.ts

beforeEach(() => {
  resolveDownloadUrl.mockImplementation(
    async (bucket: string, key: string) => ({
      url: `https://minio.test/${bucket}/${key}`,
      expiresIn: 3600,
    })
  );
});

describe("resolveMediaUrl — bucket inference by key prefix", () => {
  it.each([
    ["avatars/u1/a.png", AVATARS],
    ["group-avatars/g1/icon.webp", AVATARS],
    ["community/avatar/c1/logo.png", COMMUNITY],
    ["community/cover/c1/banner.jpg", COMMUNITY],
    ["chat-uploads/u1/file.pdf", CHAT],
    ["group-chat-uploads/g1/clip.mp4", CHAT],
    ["community-chat-uploads/c1/img.png", CHAT],
    ["legacy-unknown/x.bin", CHAT], // unrecognized → chat bucket fallback
  ])("routes %s to bucket %s", async (key, bucket) => {
    const url = await resolveMediaUrl(key);
    expect(resolveDownloadUrl).toHaveBeenCalledWith(bucket, key);
    expect(url).toBe(`https://minio.test/${bucket}/${key}`);
  });
});

describe("resolveMediaUrl — passthrough & empties", () => {
  it("returns http(s) values unchanged without signing", async () => {
    expect(await resolveMediaUrl("https://cdn.example.com/x.png")).toBe(
      "https://cdn.example.com/x.png"
    );
    expect(await resolveMediaUrl("http://cdn.example.com/y.png")).toBe(
      "http://cdn.example.com/y.png"
    );
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns '' for null / undefined / empty (missing media)", async () => {
    expect(await resolveMediaUrl(null)).toBe("");
    expect(await resolveMediaUrl(undefined)).toBe("");
    expect(await resolveMediaUrl("")).toBe("");
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("resolveMediaUrl — best-effort on failure", () => {
  it("returns '' when the strategy throws (never propagates)", async () => {
    resolveDownloadUrl.mockRejectedValueOnce(new Error("minio down"));
    await expect(resolveMediaUrl("avatars/u1/a.png")).resolves.toBe("");
  });
});

describe("resolveMediaUrlMap", () => {
  it("dedupes distinct keys, drops falsy, maps original→url", async () => {
    const map = await resolveMediaUrlMap([
      "avatars/u1/a.png",
      "avatars/u1/a.png", // duplicate
      null,
      "",
      "chat-uploads/u1/f.pdf",
    ]);
    expect(map.get("avatars/u1/a.png")).toBe(
      `https://minio.test/${AVATARS}/avatars/u1/a.png`
    );
    expect(map.get("chat-uploads/u1/f.pdf")).toBe(
      `https://minio.test/${CHAT}/chat-uploads/u1/f.pdf`
    );
    expect(map.size).toBe(2);
    // duplicate signed once; two distinct keys → two calls total
    expect(resolveDownloadUrl).toHaveBeenCalledTimes(2);
  });
});

describe("resolveContentFiles", () => {
  it("resolves each objectKey to a url, preserving other fields", async () => {
    const out = await resolveContentFiles([
      { objectKey: "chat-uploads/u1/a.pdf", name: "a.pdf", size: 10 },
    ]);
    expect(out[0]).toEqual({
      objectKey: "chat-uploads/u1/a.pdf",
      name: "a.pdf",
      size: 10,
      url: `https://minio.test/${CHAT}/chat-uploads/u1/a.pdf`,
    });
  });

  it("leaves an entry that already carries a full http url untouched", async () => {
    const entry = { url: "https://cdn.example.com/sticker.png" };
    const out = await resolveContentFiles([entry]);
    expect(out[0]).toBe(entry);
    expect(resolveDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns [] for null/empty and does not throw", async () => {
    expect(await resolveContentFiles(null)).toEqual([]);
    expect(await resolveContentFiles(undefined)).toEqual([]);
    expect(await resolveContentFiles([])).toEqual([]);
  });
});

describe("urlFromMap (sync lookup against a pre-resolved map)", () => {
  const map = new Map<string, string>([
    ["avatars/u1/a.png", "https://minio.test/aimess-avatars/avatars/u1/a.png"],
    ["https://cdn.example.com/x.png", "https://cdn.example.com/x.png"],
  ]);

  it("returns the mapped url for a known key", () => {
    expect(urlFromMap(map, "avatars/u1/a.png")).toBe(
      "https://minio.test/aimess-avatars/avatars/u1/a.png"
    );
  });

  it("passes through an http(s) value that was never signed", () => {
    expect(urlFromMap(map, "https://other.example.com/y.png")).toBe(
      "https://other.example.com/y.png"
    );
  });

  it("returns '' for an unknown non-http key or falsy input", () => {
    expect(urlFromMap(map, "avatars/unknown/z.png")).toBe("");
    expect(urlFromMap(map, null)).toBe("");
    expect(urlFromMap(map, "")).toBe("");
  });
});

describe("fileMediaKey & applyUrlMapToFiles", () => {
  it("fileMediaKey prefers objectKey, falls back to url", () => {
    expect(fileMediaKey({ objectKey: "chat-uploads/u1/a.pdf" })).toBe(
      "chat-uploads/u1/a.pdf"
    );
    expect(fileMediaKey({ url: "https://cdn/x.png" })).toBe(
      "https://cdn/x.png"
    );
    expect(fileMediaKey({})).toBe("");
  });

  it("stamps url from a pre-resolved map, keeping originals when unresolved", () => {
    const map = new Map<string, string>([
      [
        "chat-uploads/u1/a.pdf",
        "https://minio.test/aimess-chat/chat-uploads/u1/a.pdf",
      ],
    ]);
    const out = applyUrlMapToFiles(
      [
        { objectKey: "chat-uploads/u1/a.pdf", name: "a.pdf" },
        { objectKey: "chat-uploads/u1/missing.pdf", url: "old" },
      ],
      map
    );
    expect(out[0]).toEqual({
      objectKey: "chat-uploads/u1/a.pdf",
      name: "a.pdf",
      url: "https://minio.test/aimess-chat/chat-uploads/u1/a.pdf",
    });
    // unresolved key keeps its original url untouched
    expect(out[1]).toEqual({
      objectKey: "chat-uploads/u1/missing.pdf",
      url: "old",
    });
  });

  it("returns [] / passthrough for null/empty", () => {
    expect(applyUrlMapToFiles(null, new Map())).toEqual([]);
    expect(applyUrlMapToFiles([], new Map())).toEqual([]);
  });
});
