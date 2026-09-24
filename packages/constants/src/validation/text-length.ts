/**
 * Product rule: the short identity fields a person types — their username, name
 * and surname, their account handle, a community's name and handle, a group's
 * name — all cap at the SAME 30 characters. One number, because it is one
 * product decision; per-field aliases would only be seven names for one rule.
 *
 * "Characters" means what the person sees, not what the string costs: "ก" plus
 * its vowel mark, "é" as e + combining acute, and a family emoji are one each.
 * `countCharacters` is the single definition both the services and the website
 * use, so a value the form accepts is never one the API rejects.
 */
export const TEXT_NAME_MAX_LENGTH = 30;

/**
 * Hard UTF-16 ceiling for the same fields, checked BEFORE the character count.
 *
 * A grapheme cluster has no length limit of its own — combining marks can be
 * stacked until 30 "characters" weigh a megabyte — so the cheap cap runs first
 * and the segmenter only ever sees a bounded string. 200 leaves room for the
 * worst realistic case (30 Thai clusters ~ 90 code units) while keeping the
 * value inside `user_profiles.firstName`'s VarChar(200).
 */
export const TEXT_NAME_MAX_RAW_LENGTH = 200;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Length in user-perceived characters (grapheme clusters).
 *
 * `String.length` counts UTF-16 code units, so an emoji costs 2 and a Thai
 * syllable costs 2-3 — counting that way would give a Thai user roughly half
 * the field a Latin user gets. `Array.from` (code points) is the fallback where
 * `Intl.Segmenter` is missing; it still beats `.length` for emoji.
 */
export function countCharacters(value: string): number {
  if (segmenter) {
    let count = 0;
    for (const _segment of segmenter.segment(value)) count += 1;
    return count;
  }
  return Array.from(value).length;
}

/** Cut `value` down to at most `max` characters, never splitting one apart. */
export function clampCharacters(
  value: string,
  max: number = TEXT_NAME_MAX_LENGTH
): string {
  if (max <= 0) return "";
  if (segmenter) {
    const out: string[] = [];
    for (const { segment } of segmenter.segment(value)) {
      if (out.length >= max) break;
      out.push(segment);
    }
    return out.join("");
  }
  return Array.from(value).slice(0, max).join("");
}

/** True when `value` fits both the raw ceiling and the character limit. */
export function withinTextNameLimit(
  value: string,
  max: number = TEXT_NAME_MAX_LENGTH
): boolean {
  return (
    value.length <= TEXT_NAME_MAX_RAW_LENGTH && countCharacters(value) <= max
  );
}
