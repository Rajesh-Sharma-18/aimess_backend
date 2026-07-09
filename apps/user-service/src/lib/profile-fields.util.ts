const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Sentinel written at registration when the user hasn't set a real date of birth yet. */
export const PLACEHOLDER_DATE_OF_BIRTH = new Date("2000-01-01");

const MIN_PROFILE_AGE_YEARS = 13;
const MAX_PROFILE_AGE_YEARS = 120;

export const PROFILE_GENDER_VALUES = [
  "MALE",
  "FEMALE",
  "NON_BINARY",
  "PREFER_NOT_TO_SAY",
  "OTHER",
] as const;

export type ProfileGenderValue = (typeof PROFILE_GENDER_VALUES)[number];

export function isValidProfileDateOfBirth(isoDate: string): boolean {
  if (!ISO_DATE_PATTERN.test(isoDate)) {
    return false;
  }

  const [year, month, day] = isoDate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  const birthUtc = parsed.getTime();

  if (birthUtc > todayUtc) {
    return false;
  }

  const minBirthUtc = Date.UTC(
    today.getUTCFullYear() - MIN_PROFILE_AGE_YEARS,
    today.getUTCMonth(),
    today.getUTCDate()
  );

  if (birthUtc > minBirthUtc) {
    return false;
  }

  const maxBirthUtc = Date.UTC(
    today.getUTCFullYear() - MAX_PROFILE_AGE_YEARS,
    today.getUTCMonth(),
    today.getUTCDate()
  );

  if (birthUtc < maxBirthUtc) {
    return false;
  }

  return true;
}

export function dateOfBirthToUtcDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatDateOfBirth(date: Date): string | null {
  if (date.getTime() === PLACEHOLDER_DATE_OF_BIRTH.getTime()) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function buildDisplayName(firstName: string, lastName: string): string {
  return (firstName + " " + lastName).trim();
}
