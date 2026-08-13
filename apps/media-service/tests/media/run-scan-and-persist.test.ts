/**
 * Unit tests for the REAL runScanAndPersist (the worker's scan-and-persist
 * core). The scanner module is globally mocked for every other test file, so
 * here we pull the genuine implementation via jest.requireActual and mock only
 * its I/O boundary:
 *   - @aimess/storage getObjectBytes / deleteObject
 *   - the mediaScanner singleton's .scan() (spied per test)
 *   - scanStatusStore.set is spied to assert the persisted terminal status
 *     (the underlying redis client is globally mocked, so no live Redis).
 *
 * Branch matrix (per scanner.ts):
 *   CLEAN/SKIPPED scan → set CLEAN, return "CLEAN"
 *   INFECTED scan      → set INFECTED + deleteObject, return "INFECTED"
 *   missing bytes      → return "PENDING", NO Redis write
 *   scanner ERROR      → return "PENDING", NO Redis write
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

jest.mock("@aimess/storage", () => {
  const actual = jest.requireActual("@aimess/storage");
  return {
    ...actual,
    getObjectBytes: jest.fn(async () => PNG_MAGIC),
    deleteObject: jest.fn(async () => undefined),
  };
});

import { getObjectBytes, deleteObject } from "@aimess/storage";

// Real scanner implementation (bypasses tests/setup/global-mocks.ts mock).
const realScanner = jest.requireActual(
  "../../src/lib/scanner.js"
) as typeof import("../../src/lib/scanner.js");
const { runScanAndPersist, mediaScanner, scanStatusStore } = realScanner;

const mockedBytes = jest.mocked(getObjectBytes);
const mockedDelete = jest.mocked(deleteObject);

const JOB = {
  bucket: "aimess-chat-test",
  objectKey: "chat-uploads/u/file.png",
  contentType: "image/png",
};

let scanSpy: jest.SpyInstance;
let setSpy: jest.SpyInstance;

beforeEach(() => {
  mockedBytes.mockResolvedValue(PNG_MAGIC);
  scanSpy = jest.spyOn(mediaScanner, "scan");
  // Spy on the real store.set; the redis client beneath is globally mocked.
  setSpy = jest.spyOn(scanStatusStore, "set").mockResolvedValue(undefined);
});

afterEach(() => {
  scanSpy.mockRestore();
  setSpy.mockRestore();
});

describe("runScanAndPersist (real)", () => {
  it("CLEAN scan → persists CLEAN, returns 'CLEAN', no delete", async () => {
    scanSpy.mockResolvedValue({ status: "CLEAN" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("CLEAN");
    expect(setSpy).toHaveBeenCalledWith(JOB.objectKey, "CLEAN");
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("SKIPPED scan (no-op scanner) → persists CLEAN, returns 'CLEAN'", async () => {
    scanSpy.mockResolvedValue({ status: "SKIPPED" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("CLEAN");
    expect(setSpy).toHaveBeenCalledWith(JOB.objectKey, "CLEAN");
  });

  it("INFECTED scan → persists INFECTED + deletes object, returns 'INFECTED'", async () => {
    // An AV detection reports INFECTED. It previously reported QUARANTINED while
    // a structural rejection reported INFECTED — the labels were swapped, so a
    // client could not tell malware from a malformed file.
    scanSpy.mockResolvedValue({ status: "INFECTED", details: "Eicar-Test" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("INFECTED");
    expect(setSpy).toHaveBeenCalledWith(JOB.objectKey, "INFECTED");
    expect(mockedDelete).toHaveBeenCalledTimes(1);
    expect(mockedDelete).toHaveBeenCalledWith(
      expect.anything(),
      JOB.bucket,
      JOB.objectKey
    );
  });

  it("missing bytes (getObjectBytes → null) → returns 'PENDING', no Redis write, no scan", async () => {
    mockedBytes.mockResolvedValue(null);

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("PENDING");
    expect(setSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("scanner ERROR → returns 'PENDING', no Redis write, no delete", async () => {
    scanSpy.mockResolvedValue({ status: "ERROR", details: "clamd down" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("PENDING");
    expect(setSpy).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});
