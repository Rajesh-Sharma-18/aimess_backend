/**
 * Data Usage calculation — pure, no Mongo, no HTTP.
 *
 * The invariants worth guarding are the two the mock screen got wrong:
 * percentages that sum to 100, and category bytes that sum to the total.
 */

import {
  summarizeUsage,
  currentPeriodStart,
} from "../../src/lib/data-usage.js";

const MB = 1024 * 1024;

describe("summarizeUsage", () => {
  it("folds MIME types into display categories (GIF counts as IMAGE)", () => {
    const result = summarizeUsage([
      { contentType: "video/mp4", bytes: 20 * MB },
      { contentType: "image/png", bytes: 5 * MB },
      { contentType: "image/gif", bytes: 5 * MB },
      { contentType: "audio/ogg", bytes: 2 * MB },
      { contentType: "application/pdf", bytes: 3 * MB },
    ]);

    expect(result.totalBytes).toBe(35 * MB);
    expect(
      Object.fromEntries(result.categories.map((c) => [c.type, c.bytes]))
    ).toEqual({
      VIDEO: 20 * MB,
      IMAGE: 10 * MB,
      AUDIO: 2 * MB,
      DOCUMENT: 3 * MB,
    });
  });

  it("returns categories that sum to totalBytes and percentages that sum to 100", () => {
    // Thirds — the classic case where independent rounding yields 33+33+33=99.
    const result = summarizeUsage([
      { contentType: "video/mp4", bytes: 1000 },
      { contentType: "image/png", bytes: 1000 },
      { contentType: "audio/ogg", bytes: 1000 },
    ]);

    const sumBytes = result.categories.reduce((s, c) => s + c.bytes, 0);
    const sumPct = result.categories.reduce((s, c) => s + c.percentage, 0);

    expect(sumBytes).toBe(result.totalBytes);
    expect(sumPct).toBe(100);
  });

  it("keeps percentages summing to 100 across awkward splits", () => {
    // 7 equal shares → 14.28% each; naive rounding gives 98.
    const rows = [
      "video/mp4",
      "video/webm",
      "image/png",
      "image/jpeg",
      "audio/ogg",
      "audio/mpeg",
      "application/pdf",
    ].map((contentType) => ({ contentType, bytes: 1 }));

    expect(
      summarizeUsage(rows).categories.reduce((s, c) => s + c.percentage, 0)
    ).toBe(100);
  });

  it("never lets a smaller category round above a larger one", () => {
    const result = summarizeUsage([
      { contentType: "video/mp4", bytes: 5 },
      { contentType: "image/png", bytes: 5 },
      { contentType: "audio/ogg", bytes: 5 },
      { contentType: "application/pdf", bytes: 4 },
    ]);

    const doc = result.categories.find((c) => c.type === "DOCUMENT")!;
    for (const row of result.categories) {
      if (row.type === "DOCUMENT") continue;
      expect(row.percentage).toBeGreaterThanOrEqual(doc.percentage);
    }
  });

  it("empty input → zero total and no categories (not 0 MB / 100%)", () => {
    expect(summarizeUsage([])).toEqual({ totalBytes: 0, categories: [] });
  });

  it("ignores rows with no bytes", () => {
    expect(
      summarizeUsage([
        { contentType: "video/mp4", bytes: 0 },
        { contentType: "image/png", bytes: -1 },
      ])
    ).toEqual({ totalBytes: 0, categories: [] });
  });

  it("unknown MIME falls back to DOCUMENT rather than being dropped", () => {
    const result = summarizeUsage([{ contentType: "", bytes: 10 }]);
    expect(result.totalBytes).toBe(10);
    expect(result.categories).toEqual([
      { type: "DOCUMENT", bytes: 10, percentage: 100 },
    ]);
  });
});

describe("currentPeriodStart", () => {
  it("is the first instant of the containing UTC month", () => {
    expect(
      currentPeriodStart(new Date("2026-08-14T09:15:00.000Z")).toISOString()
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("is idempotent on a month boundary", () => {
    const boundary = new Date("2026-08-01T00:00:00.000Z");
    expect(currentPeriodStart(boundary).getTime()).toBe(boundary.getTime());
  });
});
