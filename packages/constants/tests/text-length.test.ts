import {
  clampCharacters,
  countCharacters,
  TEXT_NAME_MAX_LENGTH,
  TEXT_NAME_MAX_RAW_LENGTH,
  withinTextNameLimit,
} from "../src/validation/text-length.js";

/**
 * The counting definition itself. Every max-length rule in the platform — and
 * the website's copy of this file — is measured with it, so if these drift the
 * form and the API stop agreeing about what "30 characters" means.
 */
describe("countCharacters", () => {
  it("counts ASCII one per character", () => {
    expect(countCharacters("abc")).toBe(3);
    expect(countCharacters("")).toBe(0);
  });

  it("counts a precomposed and a decomposed accent the same", () => {
    expect(countCharacters("é")).toBe(1); // U+00E9
    expect(countCharacters("e\u0301")).toBe(1); // e + combining acute
  });

  it("counts a Thai syllable with its vowel mark as one", () => {
    // ก + ิ — two code points, one character to the person typing it.
    expect(countCharacters("กิ")).toBe(1);
    expect("กิ".length).toBe(2);
  });

  it("counts Vietnamese diacritics as one each", () => {
    expect(countCharacters("Nguyễn")).toBe(6);
  });

  it("counts an emoji and a ZWJ sequence as one each", () => {
    expect(countCharacters("😀")).toBe(1);
    expect("😀".length).toBe(2); // surrogate pair
    expect(countCharacters("👨‍👩‍👧‍👦")).toBe(1);
  });
});

describe("clampCharacters", () => {
  it("cuts to the limit without splitting a surrogate pair", () => {
    const clamped = clampCharacters("😀".repeat(40), TEXT_NAME_MAX_LENGTH);
    expect(countCharacters(clamped)).toBe(TEXT_NAME_MAX_LENGTH);
    // A naive slice() would leave a lone surrogate here.
    expect(clamped).toBe("😀".repeat(TEXT_NAME_MAX_LENGTH));
  });

  it("leaves a value already within the limit untouched", () => {
    expect(clampCharacters("a".repeat(30), 30)).toBe("a".repeat(30));
    expect(clampCharacters("", 30)).toBe("");
  });

  it("keeps a Thai vowel mark attached to its consonant", () => {
    expect(clampCharacters("กิกิกิ", 2)).toBe("กิกิ");
  });
});

describe("withinTextNameLimit", () => {
  it("allows 29 and 30 and refuses 31", () => {
    expect(withinTextNameLimit("a".repeat(29))).toBe(true);
    expect(withinTextNameLimit("a".repeat(30))).toBe(true);
    expect(withinTextNameLimit("a".repeat(31))).toBe(false);
    expect(withinTextNameLimit("a".repeat(50))).toBe(false);
  });

  it("gives Thai and emoji the same 30 characters as ASCII", () => {
    expect(withinTextNameLimit("กิ".repeat(30))).toBe(true);
    expect(withinTextNameLimit("กิ".repeat(31))).toBe(false);
    expect(withinTextNameLimit("😀".repeat(30))).toBe(true);
    expect(withinTextNameLimit("😀".repeat(31))).toBe(false);
  });

  it("refuses a pathological cluster on the raw ceiling before counting it", () => {
    // One "character": a base letter plus hundreds of combining marks.
    const bomb = `a${"\u0301".repeat(TEXT_NAME_MAX_RAW_LENGTH)}`;
    expect(countCharacters(bomb)).toBe(1);
    expect(withinTextNameLimit(bomb)).toBe(false);
  });
});
