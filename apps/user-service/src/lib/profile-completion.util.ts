type ProfileCompletionFields = {
  username: string | null;
  firstName: string;
  lastName: string;
};

/**
 * Derives whether a profile is "complete" from its required fields.
 *
 * Required fields: username, firstName and lastName. A profile is complete
 * only once all three are present (non-null and non-empty after trimming).
 * At registration lastName is empty, so a freshly registered profile is
 * incomplete until the user fills these in via the edit-profile screen.
 * Other fields (dateOfBirth, gender, bio, avatar) are intentionally excluded.
 */
export function isProfileComplete(profile: ProfileCompletionFields): boolean {
  const hasUsername = (profile.username ?? "").trim().length > 0;
  const hasFirstName = profile.firstName.trim().length > 0;
  const hasLastName = profile.lastName.trim().length > 0;

  return hasUsername && hasFirstName && hasLastName;
}
