/** Minimal structural shape of a Zod error — avoids coupling this shared
 *  package to a specific `zod` version. Any `ZodError` satisfies it. */
interface ZodLikeError {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
  }>;
}

/**
 * Merges Zod issue messages into a single comma-separated line, e.g.
 * `"Invalid email, Password must be at least 8 characters"`.
 *
 * Duplicate messages are collapsed — validating each element of an array
 * against the same rule otherwise repeats the identical sentence once per bad
 * element (e.g. several invalid IDs all yielding "One or more IDs are invalid.").
 *
 * Used to surface validation failures as one human-readable `message` instead
 * of Zod's raw `{ formErrors, fieldErrors }` / `issues` structures, which leak
 * internal shape and are awkward for clients to consume.
 */
export function zodErrorMessage(error: ZodLikeError): string {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const issue of error.issues) {
    if (seen.has(issue.message)) continue;
    seen.add(issue.message);
    messages.push(issue.message);
  }
  return messages.join(", ");
}
