import { localizeCategoryName, runWithLocale } from "../src/index";

describe("localizeCategoryName", () => {
  it("translates known categories and falls back for unknown ones", () => {
    expect(localizeCategoryName("General", "th")).toBe("ทั่วไป");
    expect(localizeCategoryName("Art & Design", "vi")).toBe("Nghệ thuật & Thiết kế");
    expect(localizeCategoryName("Custom", "th")).toBe("Custom");
    expect(runWithLocale("th", () => localizeCategoryName("Music"))).toBe("ดนตรี");
  });
});
