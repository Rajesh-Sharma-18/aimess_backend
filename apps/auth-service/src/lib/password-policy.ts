/**
 * What makes an acceptable NEW password.
 *
 * The policy was length-only at 8 characters, with no blocklist and no reuse
 * check, so "password", "12345678" and the account's own name were all
 * accepted. Combined with registration that issues full tokens immediately,
 * that made credential stuffing cheap: the passwords people pick unaided
 * concentrate on a very short list, and an attacker only has to try that list.
 *
 * The rules are, as of 2026-09-08 and by product decision, the classic
 * COMPOSITION set: 8-50 characters, one uppercase, one lowercase, one digit,
 * one symbol, and no whitespace anywhere.
 *
 * That is deliberately not what NIST SP 800-63B recommends, and the trade is
 * worth naming: composition rules push people toward `Password1!` — a string
 * that satisfies every rule here and sits on every cracking list. 800-63B
 * leans on length plus a blocklist instead, and the blocklist is disabled (see
 * `checkPasswordPolicy`), so nothing catches that particular password. What
 * composition does buy is the floor: it rules out the all-lowercase and
 * all-digit strings that make up most of an unaided guessing run.
 *
 * This is the CREATION policy. Login deliberately does not apply it (see
 * `auth.validator.ts`), so accounts created under the old rule keep working
 * and are asked for something stronger only when they next set a password.
 */

/**
 * Minimum length for a new password.
 *
 * 8 by product decision (2026-09-07), reverted from 12. What this gives up: an
 * 8-character password drawn from the way people actually choose them is within
 * reach of an offline attack against a stolen hash, and bcrypt's work factor
 * buys far less than length does. The blocklist that was meant to carry that
 * weight is itself disabled as of 2026-09-08 (see `checkPasswordPolicy`), so
 * the composition rules below are what stands beside this floor.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Maximum length, in characters.
 *
 * 50 by the same product decision. It sits below PASSWORD_MAX_BYTES, so for
 * ASCII this is the rule that fires; the byte cap below still matters because
 * 50 multi-byte characters can exceed 72 bytes.
 */
export const PASSWORD_MAX_LENGTH = 50;

/**
 * Maximum length, in bytes.
 *
 * 72 bytes, not an arbitrary 128: bcrypt silently TRUNCATES at 72, so anything
 * beyond that is not part of the password no matter what the form said. A user
 * who carefully typed 100 characters would have had the last 28 discarded and
 * been told nothing. Refusing is honest; accepting and truncating is not.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Passwords common enough to be tried early in any credential-stuffing run.
 *
 * Deliberately a static list rather than a dependency or a network call: the
 * check sits on registration and password reset, so it must be fast, offline
 * and unable to fail. It does not need to be exhaustive to be worth having —
 * these are the choices that make a guessing run cheap.
 *
 * Normalised comparison (lowercase, digits-for-letters undone) catches the
 * usual decorations: `P@ssw0rd`, `Passw0rd!`, `PASSWORD123`.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "passwort",
  "contrasena",
  "motdepasse",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "12345678910",
  "qwerty",
  "qwertyuiop",
  "azerty",
  "abc123",
  "abcd1234",
  "111111",
  "000000",
  "iloveyou",
  "admin",
  "administrator",
  "welcome",
  "welcome1",
  "letmein",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "batman",
  "trustno1",
  "master",
  "shadow",
  "michael",
  "jennifer",
  "jordan",
  "harley",
  "ranger",
  "hunter",
  "buster",
  "soccer",
  "hockey",
  "killer",
  "george",
  "andrew",
  "charlie",
  "thomas",
  "robert",
  "daniel",
  "starwars",
  "computer",
  "internet",
  "samsung",
  "google",
  "facebook",
  "whatsapp",
  "telegram",
  "aimess",
  "aimessapp",
  "changeme",
  "secret",
  "default",
  "temporary",
  "qazwsx",
  "zaqwsx",
  "asdfgh",
  "asdfghjkl",
  "zxcvbnm",
  "qwer1234",
  "1qaz2wsx",
  "q1w2e3r4",
  "aaaaaa",
  "photoshop",
  "freedom",
  "whatever",
  "nothing",
  "test",
  "testing",
  "guest",
  "login",
  "pass",
]);

/** Undo the character-for-character substitutions: `p@ssw0rd` -> `password`. */
function undoLeetspeak(value: string): string {
  return value
    .replace(/[@]/g, "a")
    .replace(/[$]/g, "s")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t");
}

/**
 * The forms of a password the blocklist should be compared against.
 *
 * Two distinct decorations have to be undone, and the order matters. Appended
 * digits (`password1234`) must be removed BEFORE the leet substitution, or the
 * substitution turns them into letters and the word is no longer recognisable —
 * `password1234` becomes `passwordiea`, which matches nothing. Substituted
 * characters (`p@ssw0rd`) need the opposite treatment. Both candidates are
 * generated so each decoration is caught, alone or combined.
 */
function blocklistCandidates(password: string): string[] {
  const lowered = password.toLowerCase();
  // Trailing digits and punctuation: the "make it satisfy the rules" suffix.
  const withoutSuffix = lowered.replace(/[\d\W_]+$/u, "");

  return [
    lowered,
    withoutSuffix,
    undoLeetspeak(withoutSuffix).replace(/[^a-z]/g, ""),
    undoLeetspeak(lowered).replace(/[^a-z]/g, ""),
  ].filter((candidate) => candidate.length > 0);
}

/** True when the password is a known-bad choice, decorated or not. */
export function isCommonPassword(password: string): boolean {
  for (const candidate of blocklistCandidates(password)) {
    if (COMMON_PASSWORDS.has(candidate)) return true;
  }

  // A single character repeated, or a straight run off the keyboard's number
  // row — both trivially enumerable regardless of length.
  if (/^(.)\1+$/.test(password)) return true;
  if (/^(?:0123456789|1234567890|9876543210)\d*$/.test(password)) return true;

  return false;
}

/**
 * True when the password merely restates the account name or email local part.
 *
 * These are public: the account name is how other users find you. A password
 * derived from it is guessable by anyone who can see the profile.
 */
export function containsIdentifier(
  password: string,
  identifier: string | null | undefined
): boolean {
  if (!identifier) return false;
  const local = identifier.includes("@")
    ? identifier.slice(0, identifier.indexOf("@"))
    : identifier;
  const needle = local.trim().toLowerCase();
  if (needle.length < 4) return false;
  return password.toLowerCase().includes(needle);
}

/**
 * The composition rules, in the order they are reported.
 *
 * `\s` rather than a literal space: a tab or a newline pasted in from another
 * field is just as invisible to the person typing it, and just as likely to
 * make the password unreproducible on another keyboard. Checked BEFORE the
 * symbol rule so whitespace can never be what satisfies "needs a symbol" —
 * hence `[^A-Za-z0-9\s]` there rather than a bare `[^A-Za-z0-9]`.
 */
const PASSWORD_COMPOSITION: ReadonlyArray<{
  pattern: RegExp;
  failure: PasswordPolicyFailure;
  /** True when the pattern MATCHING is the failure, rather than the pass. */
  forbidden?: true;
}> = [
  {
    pattern: /\s/u,
    failure: "AUTH_PASSWORD_CONTAINS_SPACE",
    forbidden: true,
  },
  { pattern: /[A-Z]/u, failure: "AUTH_PASSWORD_NEEDS_UPPERCASE" },
  { pattern: /[a-z]/u, failure: "AUTH_PASSWORD_NEEDS_LOWERCASE" },
  { pattern: /\d/u, failure: "AUTH_PASSWORD_NEEDS_NUMBER" },
  { pattern: /[^A-Za-z0-9\s]/u, failure: "AUTH_PASSWORD_NEEDS_SYMBOL" },
];

export type PasswordPolicyFailure =
  | "AUTH_PASSWORD_TOO_SHORT"
  | "AUTH_PASSWORD_TOO_LONG"
  | "AUTH_PASSWORD_CONTAINS_SPACE"
  | "AUTH_PASSWORD_NEEDS_UPPERCASE"
  | "AUTH_PASSWORD_NEEDS_LOWERCASE"
  | "AUTH_PASSWORD_NEEDS_NUMBER"
  | "AUTH_PASSWORD_NEEDS_SYMBOL"
  | "AUTH_PASSWORD_TOO_COMMON"
  | "AUTH_PASSWORD_CONTAINS_IDENTIFIER";

/**
 * Check a new password against the creation policy.
 *
 * Returns the first failing rule, or null when the password is acceptable.
 * `identifier` is the account name or email the password is being set for,
 * when the caller knows it.
 */
export function checkPasswordPolicy(
  password: string,
  // Unused only because the identifier rule below is commented out. The
  // parameter and its name stay so every caller keeps compiling and so
  // re-enabling the rule is a one-line revert rather than a signature change.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  identifier?: string | null
): PasswordPolicyFailure | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "AUTH_PASSWORD_TOO_SHORT";
  if (
    password.length > PASSWORD_MAX_LENGTH ||
    Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES
  ) {
    return "AUTH_PASSWORD_TOO_LONG";
  }
  for (const { pattern, failure, forbidden } of PASSWORD_COMPOSITION) {
    if (pattern.test(password) === Boolean(forbidden)) return failure;
  }
  // DISABLED BY PRODUCT DECISION (2026-09-08): the blocklist no longer refuses
  // anything, so `Test@1234`, `password1234` and `P@ssw0rd!` are all accepted.
  //
  // The client had already been told to stop DISPLAYING this refusal (see
  // `isTemporarilyHiddenError` in the web client). That left the worst of both:
  // registration still failed here, and the user was shown nothing explaining
  // why. Withdrawing the rule itself is the coherent half of that decision —
  // hiding a refusal without lifting it is not a policy, it is a dead end.
  //
  // What this gives up, and it is the whole point of the rule: the passwords
  // people pick unaided concentrate on a very short list, so an attacker only
  // has to try that list. This was the control NIST SP 800-63B leans on in
  // place of composition rules, and the identifier rule below is already off —
  // length and the bcrypt work factor are now the only things left.
  //
  // Commented rather than deleted so re-enabling is a one-line revert.
  // `isCommonPassword` stays exported and still covered by tests, and
  // `AUTH_PASSWORD_TOO_COMMON` stays in the failure union and the message
  // catalogue, for the same reason.
  //
  // if (isCommonPassword(password)) return "AUTH_PASSWORD_TOO_COMMON";
  //
  // DISABLED BY PRODUCT DECISION (2026-09-07): a password may now restate the
  // account name or email local part, so `Saul_Goodman` / `Saul_Goodman@1234`
  // is accepted.
  //
  // What this gives up: the account name is PUBLIC — it is how other users find
  // you — so a password derived from it is guessable by anyone who can see the
  // profile, and it is the first thing a targeted guessing run tries. With the
  // blocklist above now off too, length and the bcrypt work factor are the only
  // things standing behind such an account.
  //
  // Commented rather than deleted so re-enabling is a one-line revert.
  // `containsIdentifier` below is deliberately kept (still exported and still
  // covered by tests) so the rule does not have to be rewritten from scratch,
  // and `AUTH_PASSWORD_CONTAINS_IDENTIFIER` stays in the failure union and the
  // message catalogue for the same reason.
  //
  // if (containsIdentifier(password, identifier)) {
  //   return "AUTH_PASSWORD_CONTAINS_IDENTIFIER";
  // }
  return null;
}
