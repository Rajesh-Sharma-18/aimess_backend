export type ProfileCompletionFields = {
  username: string | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
};

/**
 * The ONE definition of "profile complete" for the whole platform.
 *
 * Required fields: username, firstName and lastName — complete only once all
 * three are present (non-null and non-empty after trimming). At email
 * registration the names are empty, so a freshly registered profile is
 * incomplete until the user fills them in on the profile-details screen.
 *
 * Everything else — dateOfBirth, gender, bio and the avatar — is OPTIONAL and
 * deliberately excluded. In particular the profile picture never affects this
 * answer: adding one cannot complete a profile and removing one cannot
 * un-complete it.
 *
 * It lives in the shared package rather than in user-service so auth-service's
 * social sign-UP response can answer with the same rule instead of a second
 * per-provider copy of it. Manual, Google and Apple all resolve through here.
 */
export function isProfileComplete(profile: ProfileCompletionFields): boolean {
  const hasText = (value: string | null | undefined) =>
    (value ?? "").trim().length > 0;

  return (
    hasText(profile.username) &&
    hasText(profile.firstName) &&
    hasText(profile.lastName)
  );
}
