/**
 * POST /api/v1/media/confirm — async-scan behaviour with CLAMAV_ENABLED=true.
 *
 * env.CLAMAV_ENABLED is parsed once at import, so this file mocks
 * `../../src/config/env.js` to flip it to `true` (everything else real). That
 * activates the production path: structure CLEAN → enqueueScan(); on enqueue
 * failure → runScanAndPersist() inline fallback.
 *
 * Scanner (`enqueueScan`/`runScanAndPersist`/`scanStatusStore`) is globally
 * mocked; storage `headObject`/`getObjectBytes`/`deleteObject` are mocked here
 * so the REAL structural validator returns CLEAN/REJECTED deterministically.
 */

jest.mock("../../src/config/env.js", () => {
  const actual = jest.requireActual("../../src/config/env.js");
  return { env: { ...actual.env, CLAMAV_ENABLED: true } };
});

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

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
    deleteObject: jest.fn(async () => undefined),
  };
});

import request from "supertest";
import { getObjectBytes, deleteObject } from "@aimess/storage";
import { app } from "../../src/app.js";
import {
  enqueueScan,
  runScanAndPersist,
  scanStatusStore,
} from "../../src/lib/scanner.js";
import { TEST_USER_ID, bearer, makeAccessToken } from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());
const ownKey = () => `chat-uploads/${TEST_USER_ID}/file.png`;

const mockedBytes = jest.mocked(getObjectBytes);
const mockedDelete = jest.mocked(deleteObject);
const mockedEnqueue = jest.mocked(enqueueScan);
const mockedRunScan = jest.mocked(runScanAndPersist);
const mockedStatusSet = jest.mocked(scanStatusStore.set);

beforeEach(() => {
  mockedBytes.mockResolvedValue(PNG_MAGIC);
  // Default enqueue success unless a test overrides it.
  mockedEnqueue.mockResolvedValue(true);
});

const confirm = () =>
  request(app).post("/api/v1/media/confirm").set(auth()).send({
    objectKey: ownKey(),
    category: "CHAT_ATTACHMENT",
    contentType: "image/png",
  });

describe("POST /api/v1/media/confirm (CLAMAV_ENABLED=true)", () => {
  it("200: structure CLEAN → enqueues scan, returns PENDING", async () => {
    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("PENDING");
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledWith({
      bucket: expect.any(String),
      objectKey: ownKey(),
      contentType: "image/png",
    });
    // CLEAN must NOT be set inline when enqueued — the worker decides.
    expect(mockedStatusSet).not.toHaveBeenCalledWith(ownKey(), "CLEAN");
    expect(mockedRunScan).not.toHaveBeenCalled();
  });

  it("200: enqueue fails + inline scan CLEAN → returns CLEAN", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedRunScan.mockResolvedValue("CLEAN");

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("CLEAN");
    expect(mockedRunScan).toHaveBeenCalledTimes(1);
  });

  it("200: enqueue fails + inline scan QUARANTINED → returns QUARANTINED", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedRunScan.mockResolvedValue("QUARANTINED");

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("QUARANTINED");
    expect(mockedRunScan).toHaveBeenCalledTimes(1);
  });

  it("200: enqueue fails + inline scan unresolved (PENDING) → mapped to ERROR", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedRunScan.mockResolvedValue("PENDING");

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("ERROR");
    expect(mockedRunScan).toHaveBeenCalledTimes(1);
  });

  it("200: structural REJECTED still deletes + returns INFECTED even when enabled", async () => {
    mockedBytes.mockResolvedValue(JPEG_MAGIC); // mismatch declared image/png

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("INFECTED");
    expect(mockedStatusSet).toHaveBeenCalledWith(ownKey(), "INFECTED");
    expect(mockedDelete).toHaveBeenCalledTimes(1);
    // Terminal rejection never enqueues / falls back to inline scan.
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedRunScan).not.toHaveBeenCalled();
  });
});
