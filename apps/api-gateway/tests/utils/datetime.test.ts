/**
 * Unit tests for the canonical client-facing datetime helper
 * (`@aimess/utils` → packages/utils/src/datetime.ts) and the one ApiResponse
 * behavior that depends on it.
 *
 * Contract under test (`toEpochMs`):
 *   Date            → getTime() (epoch ms)
 *   number          → passthrough
 *   ISO/parseable   → Date.parse() (epoch ms)
 *   garbage string  → null
 *   null/undefined  → null
 *   Invalid Date    → null
 *
 * The `@aimess/utils` import resolves to the package SOURCE via the jest preset
 * moduleNameMapper (^@aimess/([^/]+)$ → packages/$1/src/index.ts), so this runs
 * against the same code the build ships.
 *
 * ApiResponse regression: serializeDates converts a real `Date` field to a
 * number while leaving a pre-existing ISO **string** field untouched (we did NOT
 * start converting ISO strings — REST string/number passthrough is unchanged).
 */
import { toEpochMs, ApiResponse } from "@aimess/utils";

describe("toEpochMs", () => {
  it("Date → getTime() epoch ms", () => {
    const d = new Date("2026-06-15T10:00:10.000Z");
    expect(toEpochMs(d)).toBe(d.getTime());
    expect(toEpochMs(d)).toBe(1781517610000);
  });

  it("number → passthrough (already epoch ms)", () => {
    expect(toEpochMs(1781517610000)).toBe(1781517610000);
    expect(toEpochMs(0)).toBe(0);
  });

  it("ISO / parseable string → Date.parse() epoch ms", () => {
    const iso = "2026-06-15T10:00:10.000Z";
    expect(toEpochMs(iso)).toBe(Date.parse(iso));
  });

  it("garbage string → null", () => {
    expect(toEpochMs("not-a-date")).toBeNull();
    expect(toEpochMs("")).toBeNull();
  });

  it("null → null", () => {
    expect(toEpochMs(null)).toBeNull();
  });

  it("undefined → null", () => {
    expect(toEpochMs(undefined)).toBeNull();
  });

  it("Invalid Date → null", () => {
    expect(toEpochMs(new Date("nope"))).toBeNull();
  });

  it("NaN number → null", () => {
    expect(toEpochMs(Number.NaN)).toBeNull();
  });
});

describe("ApiResponse date serialization", () => {
  it("serializes a Date field to a number AND leaves an ISO string field a string", () => {
    const createdAt = new Date("2026-06-15T10:00:10.000Z");
    const body = new ApiResponse({
      createdAt, // real Date → epoch ms
      isoString: "2026-06-15T10:00:10.000Z", // pre-stringified ISO → untouched
    }).toJSON();

    const data = body.data as { createdAt: unknown; isoString: unknown };

    expect(typeof data.createdAt).toBe("number");
    expect(data.createdAt).toBe(createdAt.getTime());

    // The string is passed through verbatim — NOT converted to ms.
    expect(typeof data.isoString).toBe("string");
    expect(data.isoString).toBe("2026-06-15T10:00:10.000Z");
  });

  it("recurses into nested objects/arrays, converting only Date values", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    const body = new ApiResponse({
      nested: { at: d, label: "keep-me" },
      list: [{ at: d }, { iso: "2026-01-02T03:04:05.000Z" }],
    }).toJSON();

    const data = body.data as {
      nested: { at: unknown; label: unknown };
      list: Array<{ at?: unknown; iso?: unknown }>;
    };

    expect(data.nested.at).toBe(d.getTime());
    expect(data.nested.label).toBe("keep-me");
    expect(data.list[0].at).toBe(d.getTime());
    expect(data.list[1].iso).toBe("2026-01-02T03:04:05.000Z");
  });
});
