/**
 * POST /api/v1/media/confirm — async-scan behaviour (CLAMAV_ENABLED=false path).
 *
 * confirmUpload runs the REAL structural validator (magic-byte + ZIP), so this
 * file mocks `@aimess/storage` `headObject`/`getObjectBytes` to drive the
 * structural CLEAN / REJECTED branches, while keeping the real
 * `assertMagicBytesMatch`, `assertObjectKeyOwnedBy`, and `deleteObject`.
 *
 * The scanner module (`enqueueScan`/`runScanAndPersist`/`scanStatusStore`) is
 * globally mocked (tests/setup/global-mocks.ts); these tests assert against
 * those mocks.
 *
 * env.CLAMAV_ENABLED defaults to `false` in the test harness, so this file
 * exercises the dev (CLEAN-inline, no-enqueue) path plus the structural
 * rejection path. The enabled (PENDING / enqueue) paths live in
 * confirm-scan-enabled.test.ts.
 */

import { validJpeg, validPng } from "../helpers/fixtures.js";

// A STRUCTURALLY VALID PNG. The old fixture was a bare 8-byte signature, which
// the deep inspector now (correctly) rejects — a header is not a file.
const PNG_MAGIC = validPng({ width: 16, height: 16 });
// A structurally valid JPEG — mismatches a declared "image/png" → REJECTED.
const JPEG_MAGIC = validJpeg({ width: 16, height: 16 });

jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    headObject: jest.fn(async () => ({
      exists: true,
      contentLength: PNG_MAGIC.length,
      contentType: "image/png",
    })),
    getObjectBytes: jest.fn(async () => PNG_MAGIC),
    getObjectTailBytes: jest.fn(async () => null),
    deleteObject: jest.fn(async () => undefined),
  };
});

import request from "supertest";
import { headObject, getObjectBytes, deleteObject } from "@aimess/storage";
import { app } from "../../src/app.js";
import {
  enqueueScan,
  runScanAndPersist,
  scanStatusStore,
} from "../../src/lib/scanner.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());
const ownKey = () => `chat-uploads/${TEST_USER_ID}/file.png`;

const mockedHead = jest.mocked(headObject);
const mockedBytes = jest.mocked(getObjectBytes);
const mockedDelete = jest.mocked(deleteObject);
const mockedEnqueue = jest.mocked(enqueueScan);
const mockedRunScan = jest.mocked(runScanAndPersist);
const mockedStatusSet = jest.mocked(scanStatusStore.set);

beforeEach(() => {
  // global-mocks resets these (clearMocks) — re-seed structural-CLEAN defaults.
  mockedHead.mockResolvedValue({
    exists: true,
    contentLength: PNG_MAGIC.length,
    contentType: "image/png",
  });
  mockedBytes.mockResolvedValue(PNG_MAGIC);
});

describe("POST /api/v1/media/confirm (CLAMAV_ENABLED=false)", () => {
  it("200: structure CLEAN in dev → scanStatus SKIPPED (no AV engine ran), does NOT enqueue", async () => {
    const res = await request(app)
      .post("/api/v1/media/confirm")
      .set(auth())
      .send({
        objectKey: ownKey(),
        category: "CHAT_ATTACHMENT",
        contentType: "image/png",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // SKIPPED, not CLEAN: structural checks passed but no AV engine ran, and
    // conflating the two made the distinction invisible in the data.
    expect(res.body.data.scanStatus).toBe("SKIPPED");
    expect(res.body.data.objectKey).toBe(ownKey());

    // PENDING set first, then SKIPPED. Assert the terminal value was persisted.
    expect(mockedStatusSet).toHaveBeenCalledWith(ownKey(), "SKIPPED");
    // Dev path must NOT enqueue an AV scan.
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedRunScan).not.toHaveBeenCalled();
  });

  it("200: structural REJECTED (magic-byte mismatch) → scanStatus REJECTED, object deleted", async () => {
    // Declared image/png but bytes are JPEG → assertMagicBytesMatch throws → REJECTED.
    mockedBytes.mockResolvedValue(JPEG_MAGIC);

    const res = await request(app)
      .post("/api/v1/media/confirm")
      .set(auth())
      .send({
        objectKey: ownKey(),
        category: "CHAT_ATTACHMENT",
        contentType: "image/png",
      });

    expect(res.status).toBe(200);
    // REJECTED, not INFECTED: a malformed file is not a virus. The two labels
    // were previously swapped relative to their names.
    expect(res.body.data.scanStatus).toBe("REJECTED");
    expect(mockedStatusSet).toHaveBeenCalledWith(ownKey(), "REJECTED");
    expect(mockedDelete).toHaveBeenCalledTimes(1);
    // Terminal rejection never reaches the AV enqueue/inline path.
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedRunScan).not.toHaveBeenCalled();
  });

  it("403: confirm of a key owned by a different user", async () => {
    const otherKey = "chat-uploads/99999999-9999-4999-8999-999999999999/x.png";
    const res = await request(app)
      .post("/api/v1/media/confirm")
      .set(auth())
      .send({
        objectKey: otherKey,
        category: "CHAT_ATTACHMENT",
        contentType: "image/png",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    // Authz fails before any structural read.
    expect(mockedHead).not.toHaveBeenCalled();
  });

  it("400: missing objectKey", async () => {
    const res = await request(app)
      .post("/api/v1/media/confirm")
      .set(auth())
      .send({ category: "CHAT_ATTACHMENT", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("401: no token", async () => {
    const res = await request(app).post("/api/v1/media/confirm").send({
      objectKey: ownKey(),
      category: "CHAT_ATTACHMENT",
      contentType: "image/png",
    });

    expect(res.status).toBe(401);
  });
});
