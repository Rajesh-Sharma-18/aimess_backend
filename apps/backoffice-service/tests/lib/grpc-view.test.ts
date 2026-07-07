import { buildFullName, orNull } from "../../src/lib/grpc-view.js";

describe("buildFullName", () => {
  it('joins firstName + " " + lastName when both exist', () => {
    expect(buildFullName("John", "Doe")).toBe("John Doe");
  });

  it("trims extra whitespace around each part before joining", () => {
    expect(buildFullName("  John  ", "  Doe  ")).toBe("John Doe");
  });

  it("returns firstName only when lastName is absent", () => {
    expect(buildFullName("John", undefined)).toBe("John");
    expect(buildFullName("John", "")).toBe("John");
  });

  it("returns lastName only when firstName is absent", () => {
    expect(buildFullName(undefined, "Doe")).toBe("Doe");
    expect(buildFullName("", "Doe")).toBe("Doe");
  });

  it("returns null when both are missing", () => {
    expect(buildFullName(undefined, undefined)).toBeNull();
    expect(buildFullName("", "")).toBeNull();
  });

  it("returns null when both are whitespace-only", () => {
    expect(buildFullName("   ", "   ")).toBeNull();
  });
});

describe("orNull", () => {
  it("returns the value unchanged when truthy", () => {
    expect(orNull("b@x.com")).toBe("b@x.com");
  });

  it("returns null for an empty string", () => {
    expect(orNull("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(orNull(undefined)).toBeNull();
  });
});
