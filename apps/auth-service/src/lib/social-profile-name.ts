/**
 * Normalizes the name a social provider hands us into the (firstName, lastName)
 * pair the AIMess user profile stores.
 *
 * Structured given/family names always win: when the provider already told us
 * which part is which, splitting a full name would only be a chance to get it
 * wrong (compound surnames, "Last First" locales). The full-name split is a
 * fallback for providers that send `name` but no `given_name`/`family_name`.
 *
 * Every field is optional in, optional out — a provider that sends nothing must
 * produce `null`, never an empty string, so downstream never overwrites a real
 * stored name with a blank.
 */
export type SocialProfileName = {
  firstName: string | null;
  lastName: string | null;
  /** `firstName lastName` joined, or the raw full name; null when nothing is known. */
  displayName: string | null;
};

/** VarChar(50) in user_profiles.firstName / .lastName. */
const NAME_MAX_LENGTH = 50;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, NAME_MAX_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveSocialProfileName(input: {
  givenName?: unknown;
  familyName?: unknown;
  fullName?: unknown;
}): SocialProfileName {
  const given = clean(input.givenName);
  const family = clean(input.familyName);
  const full = clean(input.fullName);

  let firstName = given;
  let lastName = family;

  // Only split when the provider gave NO structured part at all.
  if (!firstName && !lastName && full) {
    const parts = full.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 1) {
      firstName = parts[0] ?? null;
    } else if (parts.length > 1) {
      // Last token is the surname; everything before it is the given name(s),
      // which keeps "Maria Del Carmen Sharma" from losing its middle parts.
      lastName = clean(parts[parts.length - 1]);
      firstName = clean(parts.slice(0, -1).join(" "));
    }
  }

  const joined = [firstName, lastName].filter(Boolean).join(" ");
  const displayName = joined.length > 0 ? joined : full;

  return { firstName, lastName, displayName };
}
