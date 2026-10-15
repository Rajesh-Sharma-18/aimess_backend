const EDGE_INVISIBLE_SOURCE =
  "\\p{White_Space}\\p{Cc}\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\u2800\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0001}";

const NON_VISIBLE_SOURCE = `${EDGE_INVISIBLE_SOURCE}\\p{M}\\u180B-\\u180D\\u180F\\uFE00-\\uFE0F\\u{E0020}-\\u{E007F}\\u{E0100}-\\u{E01EF}`;

const LEADING_INVISIBLE = new RegExp(`^[${NON_VISIBLE_SOURCE}]+`, "u");
const TRAILING_INVISIBLE = new RegExp(`[${EDGE_INVISIBLE_SOURCE}]+$`, "u");
const VISIBLE_CHARACTER = new RegExp(`[^${NON_VISIBLE_SOURCE}]`, "u");

export function hasVisibleText(value: string | null | undefined): boolean {
  return !!value && VISIBLE_CHARACTER.test(value);
}

export function normalizeVisibleText(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = value.normalize("NFC");
  if (!hasVisibleText(normalized)) return "";
  return normalized.replace(LEADING_INVISIBLE, "").replace(TRAILING_INVISIBLE, "");
}
