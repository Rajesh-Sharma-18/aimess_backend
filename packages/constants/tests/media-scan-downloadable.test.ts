/**
 * AIM-49 — an object that no antivirus engine ever inspected must not be
 * servable by default.
 *
 * `SKIPPED` is what `/media/confirm` writes when the scanner is switched off.
 * It used to sit in the downloadable allow-list unconditionally, so a
 * deployment running without ClamAV fanned unscanned uploads out to every
 * recipient with a working download URL. It is now opt-in per call, and
 * media-service only opts in when it is knowingly running without a scanner
 * (production refuses to boot in that state at all).
 */
import {
  DOWNLOADABLE_SCAN_STATUSES,
  UNSCANNED_DOWNLOADABLE_SCAN_STATUSES,
  isDownloadableScanStatus,
} from "@aimess/constants";

describe("isDownloadableScanStatus", () => {
  it("serves a CLEAN object in every configuration", () => {
    expect(isDownloadableScanStatus("CLEAN")).toBe(true);
    expect(isDownloadableScanStatus("CLEAN", { allowUnscanned: true })).toBe(
      true
    );
    expect(isDownloadableScanStatus("CLEAN", { allowUnscanned: false })).toBe(
      true
    );
  });

  it("refuses an unscanned (SKIPPED) object unless the caller opts in", () => {
    // The default is what any forgetful future caller inherits.
    expect(isDownloadableScanStatus("SKIPPED")).toBe(false);
    expect(isDownloadableScanStatus("SKIPPED", {})).toBe(false);
    expect(isDownloadableScanStatus("SKIPPED", { allowUnscanned: false })).toBe(
      false
    );

    // Only a deployment that openly runs without a scanner may serve it.
    expect(isDownloadableScanStatus("SKIPPED", { allowUnscanned: true })).toBe(
      true
    );
  });

  it.each(["PENDING", "SCANNING", "REJECTED", "INFECTED", "QUARANTINED", "ERROR"])(
    "never serves %s, with or without a scanner",
    (status) => {
      expect(isDownloadableScanStatus(status)).toBe(false);
      expect(isDownloadableScanStatus(status, { allowUnscanned: true })).toBe(
        false
      );
    }
  );

  it("blocks unknown or future statuses (allow-list, not deny-list)", () => {
    expect(isDownloadableScanStatus("SOMETHING_NEW")).toBe(false);
    expect(
      isDownloadableScanStatus("SOMETHING_NEW", { allowUnscanned: true })
    ).toBe(false);
    expect(isDownloadableScanStatus("")).toBe(false);
  });

  it("keeps SKIPPED out of the default allow-list constant", () => {
    expect(DOWNLOADABLE_SCAN_STATUSES).toEqual(["CLEAN"]);
    expect(UNSCANNED_DOWNLOADABLE_SCAN_STATUSES).toContain("SKIPPED");
    expect(UNSCANNED_DOWNLOADABLE_SCAN_STATUSES).toContain("CLEAN");
  });
});
