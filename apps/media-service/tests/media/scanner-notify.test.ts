/**
 * Unit tests for the realtime scan-failure notify (publishScanResult) and its
 * wiring into the REAL runScanAndPersist. The scanner module is globally mocked
 * for every other test file, so here we pull the genuine implementation via
 * jest.requireActual and mock only its I/O boundary:
 *   - @aimess/storage getObjectBytes / deleteObject
 *   - the mediaScanner singleton's .scan() (spied per test)
 *   - the config/redis.js mock's `publish` (asserted; no live Redis)
 *
 * Acceptance:
 *   INFECTED async scan → publishes exactly one notify:<uploaderId>
 *     media:scan_result (status QUARANTINED)
 *   CLEAN scan          → publishes nothing
 *   bad object key      → no publish (uploaderId underivable)
 *   publish failure     → never throws / never breaks the scan
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

import { getObjectBytes } from "@aimess/storage";
import { redis } from "../../src/config/redis.js";

// Real scanner implementation (bypasses tests/setup/global-mocks.ts mock).
const realScanner = jest.requireActual(
  "../../src/lib/scanner.js"
) as typeof import("../../src/lib/scanner.js");
const { runScanAndPersist, publishScanResult, mediaScanner, scanStatusStore } =
  realScanner;

const mockedBytes = jest.mocked(getObjectBytes);
const mockedPublish = jest.mocked(redis.publish);

const OWNER = "uploader-42";
const JOB = {
  bucket: "aimess-chat-test",
  objectKey: `chat-uploads/${OWNER}/file.png`,
  contentType: "image/png",
};

let scanSpy: jest.SpyInstance;
let setSpy: jest.SpyInstance;

beforeEach(() => {
  mockedBytes.mockResolvedValue(PNG_MAGIC);
  mockedPublish.mockResolvedValue(0);
  scanSpy = jest.spyOn(mediaScanner, "scan");
  setSpy = jest.spyOn(scanStatusStore, "set").mockResolvedValue(undefined);
});

afterEach(() => {
  scanSpy.mockRestore();
  setSpy.mockRestore();
  jest.clearAllMocks();
});

describe("publishScanResult", () => {
  it("publishes media:scan_result to notify:<uploaderId> derived from the key", () => {
    publishScanResult(JOB.objectKey, "INFECTED");

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockedPublish.mock.calls[0];
    expect(channel).toBe(`notify:${OWNER}`);
    const parsed = JSON.parse(raw as string);
    expect(parsed.event).toBe("media:scan_result");
    expect(parsed.data.objectKey).toBe(JOB.objectKey);
    expect(parsed.data.status).toBe("INFECTED");
    expect(typeof parsed.data.at).toBe("number");
  });

  it("carries NO reason field — detector detail must never reach the client", () => {
    // This payload used to carry a free-text `reason`, fed variously with the
    // ClamAV signature name, the structural validator's thresholds/offsets, and
    // — on a terminal Bull failure — raw MinIO SDK errors naming the endpoint
    // and bucket. It is status-only now; the detail goes to the audit log.
    publishScanResult(JOB.objectKey, "ERROR");

    const parsed = JSON.parse(mockedPublish.mock.calls[0][1] as string);
    expect(parsed.data.reason).toBeUndefined();
    expect(Object.keys(parsed.data).sort()).toEqual([
      "at",
      "objectKey",
      "status",
    ]);
  });

  it("skips publishing when the uploader id cannot be derived", () => {
    publishScanResult("malformed-key-no-owner", "INFECTED");
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("never throws when redis.publish rejects", () => {
    mockedPublish.mockRejectedValueOnce(new Error("redis down"));
    expect(() => publishScanResult(JOB.objectKey, "INFECTED")).not.toThrow();
  });
});

describe("runScanAndPersist → notify wiring", () => {
  it("INFECTED scan publishes exactly one INFECTED scan_result", async () => {
    scanSpy.mockResolvedValue({ status: "INFECTED", details: "Eicar-Test" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("INFECTED");
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(mockedPublish.mock.calls[0][1] as string);
    expect(parsed.event).toBe("media:scan_result");
    expect(parsed.data.status).toBe("INFECTED");
    // The signature name stays internal.
    expect(JSON.stringify(parsed)).not.toContain("Eicar-Test");
  });

  it("CLEAN scan publishes nothing", async () => {
    scanSpy.mockResolvedValue({ status: "CLEAN" });

    const result = await runScanAndPersist(JOB);

    expect(result).toBe("CLEAN");
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("a publish failure never breaks an INFECTED scan", async () => {
    scanSpy.mockResolvedValue({ status: "INFECTED", details: "x" });
    mockedPublish.mockRejectedValueOnce(new Error("redis down"));

    await expect(runScanAndPersist(JOB)).resolves.toBe("INFECTED");
  });
});
