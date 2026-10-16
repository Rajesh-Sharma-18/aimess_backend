import {
  hasVisibleText,
  normalizeVisibleText,
} from "../src/validation/visible-text.js";

const BLANK_INPUTS: Array<[string, string]> = [
  ["empty", ""],
  ["ordinary spaces", "    "],
  ["tabs and newlines", "\t\n\r\v\f"],
  ["unicode spaces", "       　"],
  ["line and paragraph separators", "  \u0085"],
  ["zero-width space", "​"],
  ["zero-width joiners", "‌‍"],
  ["byte order mark", "﻿"],
  ["word joiner and invisible operators", "⁠⁡⁢⁣⁤"],
  ["soft hyphen", "­"],
  ["bidi controls", "‎‏‪‫‬‭‮⁦⁧⁨⁩؜"],
  ["mongolian vowel separator", "᠎"],
  ["braille blank", "⠀"],
  ["hangul fillers", "ㅤﾠᅟᅠ"],
  ["khmer inherent vowels", "឴឵"],
  ["combining grapheme joiner", "͏"],
  ["variation selectors", "️︀\u{E0100}"],
  ["tag characters", "\u{E0001}\u{E0067}\u{E007F}"],
  ["lone combining marks", "́̀ั"],
  ["control characters", "\u0000\u0007\u001B\u007F"],
  ["mixed invisible and whitespace", " ​\t⠀ㅤ﻿\n‍ "],
];

describe("hasVisibleText", () => {
  it.each(BLANK_INPUTS)("rejects %s", (_label, value) => {
    expect(hasVisibleText(value)).toBe(false);
    expect(normalizeVisibleText(value)).toBe("");
  });

  it("rejects null and undefined", () => {
    expect(hasVisibleText(null)).toBe(false);
    expect(hasVisibleText(undefined)).toBe(false);
    expect(normalizeVisibleText(undefined)).toBe("");
  });

  it.each([
    ["latin", "Niral"],
    ["thai", "สมชาย"],
    ["vietnamese", "Nguyễn"],
    ["devanagari with virama", "क्षत्रिय"],
    ["persian with zwnj", "می‌خواهم"],
    ["malayalam chillu with zwj", "ന്‍"],
    ["arabic", "محمد"],
    ["chinese", "王小明"],
    ["korean", "김민준"],
    ["emoji", "😀"],
    ["emoji zwj family", "👨‍👩‍👧‍👦"],
    ["keycap", "1️⃣"],
    ["punctuation only", "."],
    ["visible char hidden among invisibles", "​⠀aㅤ"],
  ])("accepts %s", (_label, value) => {
    expect(hasVisibleText(value)).toBe(true);
  });
});

describe("normalizeVisibleText", () => {
  it("trims ordinary and unicode whitespace at both ends", () => {
    expect(normalizeVisibleText("  Niral \t\n")).toBe("Niral");
    expect(normalizeVisibleText("　 Niral ")).toBe("Niral");
  });

  it("trims invisible formatting characters at both ends", () => {
    expect(normalizeVisibleText("​﻿Niral​⠀ㅤ")).toBe("Niral");
    expect(normalizeVisibleText("‮Niral⁦")).toBe("Niral");
  });

  it("keeps interior spaces and punctuation", () => {
    expect(normalizeVisibleText("  Mary-Jane  O'Neil ")).toBe("Mary-Jane  O'Neil");
  });

  it("keeps interior joiners that carry meaning", () => {
    expect(normalizeVisibleText("می‌خواهم")).toBe("می‌خواهم");
    expect(normalizeVisibleText(" 👨‍👩‍👧‍👦 ")).toBe("👨‍👩‍👧‍👦");
  });

  it("keeps trailing emoji presentation and subdivision flag tags", () => {
    expect(normalizeVisibleText("love ❤️")).toBe("love ❤️");
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(normalizeVisibleText(`go ${england}`)).toBe(`go ${england}`);
  });

  it("keeps trailing combining marks of the last letter", () => {
    expect(normalizeVisibleText("กิ")).toBe("กิ");
  });

  it("composes to NFC so decomposed and precomposed input match", () => {
    expect(normalizeVisibleText("é")).toBe("é");
    expect(normalizeVisibleText("Nguyễn")).toBe("Nguyễn");
  });
});
