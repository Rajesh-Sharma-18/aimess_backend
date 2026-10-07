import { currentLocale } from "../locale-context.js";
import type { SupportedLocale } from "../locale.js";

// ponytail: keyed by the stored English name; an admin-created/renamed category falls back to its stored name.
const CATEGORY_NAMES: Record<string, Record<SupportedLocale, string>> = {
  General: { en: "General", vi: "Chung", th: "ทั่วไป" },
  "Sports & Fitness": {
    en: "Sports & Fitness",
    vi: "Thể thao & Thể hình",
    th: "กีฬาและฟิตเนส",
  },
  Gaming: { en: "Gaming", vi: "Trò chơi", th: "เกม" },
  Music: { en: "Music", vi: "Âm nhạc", th: "ดนตรี" },
  Education: { en: "Education", vi: "Giáo dục", th: "การศึกษา" },
  Technology: { en: "Technology", vi: "Công nghệ", th: "เทคโนโลยี" },
  "Art & Design": {
    en: "Art & Design",
    vi: "Nghệ thuật & Thiết kế",
    th: "ศิลปะและการออกแบบ",
  },
  "Food & Cooking": {
    en: "Food & Cooking",
    vi: "Ẩm thực & Nấu ăn",
    th: "อาหารและการทำอาหาร",
  },
  Travel: { en: "Travel", vi: "Du lịch", th: "ท่องเที่ยว" },
  Business: { en: "Business", vi: "Kinh doanh", th: "ธุรกิจ" },
};

export function localizeCategoryName(
  name: string,
  locale: SupportedLocale = currentLocale()
): string {
  return CATEGORY_NAMES[name]?.[locale] ?? name;
}
