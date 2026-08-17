/**
 * resolveSocialProfileName — the (firstName, lastName) normalization shared by
 * the Google token claims and the Apple first-authorization response.
 */
import { resolveSocialProfileName } from "../../src/lib/social-profile-name.js";

describe("resolveSocialProfileName", () => {
  it("prefers structured given/family names over the full name", () => {
    expect(
      resolveSocialProfileName({
        givenName: "Rajesh",
        familyName: "Sharma",
        fullName: "Totally Different Name",
      })
    ).toEqual({
      firstName: "Rajesh",
      lastName: "Sharma",
      displayName: "Rajesh Sharma",
    });
  });

  it("does not split the full name when only one structured part is present", () => {
    expect(
      resolveSocialProfileName({ givenName: "Rajesh", fullName: "A B C" })
    ).toMatchObject({ firstName: "Rajesh", lastName: null });
  });

  it("splits a full name on the LAST token when no structured part exists", () => {
    expect(
      resolveSocialProfileName({ fullName: "Maria Del Carmen Sharma" })
    ).toMatchObject({ firstName: "Maria Del Carmen", lastName: "Sharma" });
  });

  it("keeps a single-token full name as the first name only", () => {
    expect(resolveSocialProfileName({ fullName: "Cher" })).toMatchObject({
      firstName: "Cher",
      lastName: null,
    });
  });

  it.each([
    ["all missing", {}],
    ["explicit nulls", { givenName: null, familyName: null, fullName: null }],
    ["blank strings", { givenName: "  ", familyName: "", fullName: "   " }],
    ["wrong types", { givenName: 42, familyName: {}, fullName: [] }],
  ])("yields nulls, never empty strings: %s", (_label, input) => {
    expect(resolveSocialProfileName(input)).toEqual({
      firstName: null,
      lastName: null,
      displayName: null,
    });
  });

  it("caps each part at the 50-char column width", () => {
    const long = "a".repeat(80);
    const { firstName } = resolveSocialProfileName({ givenName: long });
    expect(firstName).toHaveLength(50);
  });
});
