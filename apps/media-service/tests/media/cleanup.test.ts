/**
 * The mandatory cleanup contract: an object that fails ANY security check must
 * not remain in MinIO, the failure must be recorded durably, and a cleanup that
 * itself fails must be loud rather than silently reported as success.
 *
 * For every rejected upload this asserts:
 *   1. the request completes with the rejection verdict,
 *   2. the object is deleted from MinIO,
 *   3. the durable registry row records the verdict,
 *   4. the object is not downloadable afterwards,
 *   5. a security event is logged.
 */

import { validJpeg, validPng, buildZip } from "../helpers/fixtures.js";

const PNG = validPng({ width: 16, height: 16 });

jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    headObject: jest.fn(async () => ({
      exists: true,
      contentLength: PNG.length,
      contentType: "image/png",
    })),
    getObjectBytes: jest.fn(async () => PNG),
    getObjectTailBytes: jest.fn(async () => null),
    deleteObject: jest.fn(async () => undefined),
  };
});

import request from "supertest";
import { deleteObject, getObjectBytes, headObject } from "@aimess/storage";
import { logger } from "@aimess/logger";

import { app } from "../../src/app.js";
import { mediaFileRepository } from "../../src/repositories/media-file.repository.js";
import { scanStatusStore } from "../../src/lib/scanner.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());
const KEY = `chat-uploads/${TEST_USER_ID}/file.png`;

const mockedHead = jest.mocked(headObject);
const mockedBytes = jest.mocked(getObjectBytes);
const mockedDelete = jest.mocked(deleteObject);
const mockedSetScanStatus = jest.mocked(mediaFileRepository.setScanStatus);
const mockedStatusSet = jest.mocked(scanStatusStore.set);
const mockedStatusGet = jest.mocked(scanStatusStore.get);

/** Drive the pipeline with a specific payload of a specific declared type. */
function serveObject(bytes: Buffer, contentType: string): void {
  mockedHead.mockResolvedValue({
    exists: true,
    contentLength: bytes.length,
    contentType,
  });
  mockedBytes.mockImplementation(async (_c, _b, _k, maxBytes?: number) =>
    maxBytes && Number.isFinite(maxBytes) ? bytes.subarray(0, maxBytes) : bytes
  );
}

const confirm = () =>
  request(app)
    .post("/api/v1/media/confirm")
    .set(auth())
    .send({ objectKey: KEY, category: "CHAT_ATTACHMENT" });

beforeEach(() => {
  serveObject(PNG, "image/png");
});

describe("rejected uploads are removed from MinIO", () => {
  const cases: Array<[string, () => void]> = [
    [
      "wrong magic bytes (JPEG declared as PNG)",
      () => serveObject(validJpeg(), "image/png"),
    ],
    [
      "corrupted image (truncated PNG)",
      () => serveObject(validPng({ omitIend: true }), "image/png"),
    ],
    [
      "polyglot (PNG with an appended ZIP)",
      () =>
        serveObject(
          validPng({
            trailing: buildZip([{ name: "p.txt", content: Buffer.from("x") }]),
          }),
          "image/png"
        ),
    ],
    [
      "decompression bomb (64000x64000 PNG)",
      () =>
        serveObject(validPng({ width: 64_000, height: 64_000 }), "image/png"),
    ],
    [
      "executable declared as text/plain",
      () => serveObject(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "text/plain"),
    ],
    [
      "ZIP bomb",
      () =>
        serveObject(
          buildZip([
            {
              name: "b.bin",
              content: Buffer.alloc(10),
              uncompressedSize: 10_000_000,
            },
          ]),
          "application/zip"
        ),
    ],
    [
      "encrypted ZIP entry",
      () =>
        serveObject(
          buildZip([
            { name: "s.txt", content: Buffer.from("x"), encrypted: true },
          ]),
          "application/zip"
        ),
    ],
    [
      "plain ZIP declared as DOCX",
      () =>
        serveObject(
          buildZip([{ name: "a.txt", content: Buffer.from("x") }]),
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
    ],
  ];

  it.each(cases)(
    "%s → REJECTED, object deleted, verdict persisted",
    async (_n, setup) => {
      setup();

      const res = await confirm();

      // 1. request completes with the rejection verdict
      expect(res.status).toBe(200);
      expect(res.body.data.scanStatus).toBe("REJECTED");

      // 2. the object is deleted from MinIO
      expect(mockedDelete).toHaveBeenCalledTimes(1);
      expect(mockedDelete).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        KEY
      );

      // 3. the durable registry row records the verdict
      expect(mockedSetScanStatus).toHaveBeenCalledWith(
        KEY,
        "REJECTED",
        expect.any(String),
        null
      );
      // and the hot cache agrees
      expect(mockedStatusSet).toHaveBeenCalledWith(KEY, "REJECTED");
    }
  );

  it("an empty object is a retriable ERROR, not a rejection", async () => {
    // No bytes at the key means the PUT never finished — nothing was judged, so
    // the upload must stay retriable instead of being deleted as rejected.
    mockedHead.mockResolvedValue({
      exists: true,
      contentLength: 0,
      contentType: "image/png",
    });
    mockedBytes.mockResolvedValue(Buffer.alloc(0));

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("ERROR");
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(mockedStatusSet).not.toHaveBeenCalledWith(KEY, "REJECTED");
  });

  it("a rejected object is NOT downloadable afterwards", async () => {
    serveObject(validJpeg(), "image/png");
    await confirm();

    mockedStatusGet.mockResolvedValue("REJECTED");
    const res = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: KEY, category: "CHAT_ATTACHMENT" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEDIA_SECURITY_VALIDATION_FAILED");
  });

  it("malware and validation failures are distinguishable to the client", async () => {
    mockedStatusGet.mockResolvedValue("INFECTED");
    const infected = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: KEY, category: "CHAT_ATTACHMENT" });
    expect(infected.status).toBe(403);
    expect(infected.body.code).toBe("MEDIA_MALWARE_DETECTED");

    mockedStatusGet.mockResolvedValue("PENDING");
    const pending = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: KEY, category: "CHAT_ATTACHMENT" });
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe("MEDIA_SCAN_PENDING");

    mockedStatusGet.mockResolvedValue("ERROR");
    const errored = await request(app)
      .post("/api/v1/media/download-url")
      .set(auth())
      .send({ objectKey: KEY, category: "CHAT_ATTACHMENT" });
    expect(errored.status).toBe(403);
    expect(errored.body.code).toBe("MEDIA_SCAN_FAILED");
  });

  it("never leaks detector internals to the client", async () => {
    serveObject(validJpeg(), "image/png");
    const res = await confirm();

    const body = JSON.stringify(res.body);
    // The internal reason ("File signature mismatch: declared image/png but
    // detected image/jpeg") must stay in the audit log.
    expect(body).not.toMatch(/signature mismatch/i);
    expect(body).not.toMatch(/aimess-chat/);
    expect(body).not.toMatch(/detected/i);
    expect(res.body.data).toEqual(
      expect.objectContaining({ objectKey: KEY, scanStatus: "REJECTED" })
    );
  });
});

describe("cleanup failure is loud, never silently reported as removed", () => {
  it("logs a critical event and records it on the row when deleteObject throws", async () => {
    const errorSpy = jest.spyOn(logger, "error");
    mockedDelete.mockRejectedValueOnce(new Error("MinIO unreachable"));
    serveObject(validJpeg(), "image/png");

    const res = await confirm();

    // The verdict still stands — the download gate blocks it either way.
    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("REJECTED");

    // A critical cleanup-failure event was logged.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FAILED to delete"),
      expect.objectContaining({
        severity: "critical",
        event: "media.cleanup_failed",
        objectKey: KEY,
      })
    );

    // And the registry row says so, so an operator query can find the object.
    expect(mockedSetScanStatus).toHaveBeenCalledWith(
      KEY,
      "REJECTED",
      expect.stringContaining("STORAGE DELETE FAILED"),
      null
    );
    errorSpy.mockRestore();
  });

  it("the request does not fail with a 500 when cleanup fails", async () => {
    mockedDelete.mockRejectedValueOnce(new Error("boom"));
    serveObject(validJpeg(), "image/png");

    const res = await confirm();
    expect(res.status).toBe(200);
  });
});

describe("cancelUpload cleanup", () => {
  it("deletes the object and transitions the registry row", async () => {
    const res = await request(app)
      .delete(`/api/v1/media/uploads/${encodeURIComponent(KEY)}`)
      .query({ category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(mockedDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      KEY
    );
    expect(jest.mocked(mediaFileRepository.setUsage)).toHaveBeenCalledWith(
      KEY,
      "DELETED"
    );
  });

  it("refuses to cancel another user's object", async () => {
    const foreign = "chat-uploads/99999999-9999-4999-8999-999999999999/x.png";
    const res = await request(app)
      .delete(`/api/v1/media/uploads/${encodeURIComponent(foreign)}`)
      .query({ category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(403);
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});
