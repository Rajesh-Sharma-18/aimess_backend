import { accentInsensitivePattern } from "../../src/repositories/message-search.js";

const matches = (query: string, text: string) =>
  new RegExp(accentInsensitivePattern(query), "i").test(text);

describe("accentInsensitivePattern", () => {
  it("finds Vietnamese text from an unaccented query", () => {
    expect(matches("duong pho", "Đây là Đường phố Hà Nội")).toBe(true);
    expect(matches("Sai Gon", "Sài Gòn nay đẹp quá")).toBe(true);
  });

  it("an accented query also matches the other accent spellings", () => {
    expect(matches("Sài Gòn", "sai gon")).toBe(true);
    expect(matches("đẹp", "DEP")).toBe(true);
  });

  it("still requires the letters to be the same", () => {
    expect(matches("duong pho", "Đường phải")).toBe(false);
    expect(matches("ha noi", "Hà Nam")).toBe(false);
  });

  it("keeps regex metacharacters literal", () => {
    expect(matches("c++ (v2)", "use c++ (v2) now")).toBe(true);
    expect(matches("a.b", "axb")).toBe(false);
  });
});
