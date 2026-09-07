/**
 * The search cursor codec. Both halves of "<ms>_<objectId>" are validated at
 * parse time because the id half is fed straight into `_id: { $lt: { $oid } }`
 * inside `aggregateRaw` — a foreign cursor shaped like the inbox's
 * "<ms>_prv_abc" used to reach the BSON layer and surface as an unhandled 500.
 *
 * Lives with the other search suites rather than beside the module: jest's
 * `roots` is `<rootDir>/tests`, so a test file under `src/` never runs.
 */

import {
  buildSearchCursor,
  newestSearchCursor,
  parseSearchCursor,
} from "../../src/repositories/message-search.js";

const OID = "507f1f77bcf86cd799439011";

describe("parseSearchCursor", () => {
  it("rejects an id half that is not a 24-hex ObjectId", () => {
    // The exact shape the frontend fans across param names: an inbox cursor.
    expect(parseSearchCursor("1782133107521_prv_abc")).toBeNull();
    expect(parseSearchCursor(`1782133107521_${OID}z`)).toBeNull();
  });

  it("rejects an empty ms half — Number('') is 0, not NaN", () => {
    expect(parseSearchCursor(`_${OID}`)).toBeNull();
  });

  it("rejects a non-numeric or out-of-Date-range ms half", () => {
    expect(parseSearchCursor("abc")).toBeNull();
    expect(parseSearchCursor(`${"9".repeat(400)}_${OID}`)).toBeNull();
  });

  it("round-trips a cursor built from a row", () => {
    const at = new Date("2026-09-01T10:00:00.000Z");
    const raw = buildSearchCursor(at, OID);
    expect(raw).toBe(`${at.getTime()}_${OID}`);
    expect(parseSearchCursor(raw)).toEqual({
      createdAt: at.getTime(),
      id: OID,
    });
  });

  it("accepts a bare epoch-ms cursor (no tiebreaker yet)", () => {
    expect(parseSearchCursor("1782133107521")).toEqual({
      createdAt: 1782133107521,
      id: "",
    });
  });
});

describe("newestSearchCursor", () => {
  // The empty-merged-page fallback: resuming from the DEEPEST floor would skip
  // the rows a shallower leg never scanned, so the newest floor is the safe one.
  it("picks the newest floor and ignores unparseable ones", () => {
    expect(
      newestSearchCursor([`100_${OID}`, `900_${OID}`, "garbage", null])
    ).toBe(`900_${OID}`);
  });

  it("is null when no leg can name where to resume", () => {
    expect(newestSearchCursor([null, undefined, "1782133107521_prv_abc"])).toBe(
      null
    );
  });
});
