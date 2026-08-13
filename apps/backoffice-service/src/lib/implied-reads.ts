import { PERMISSIONS } from "../constants/index.js";

/**
 * Every module in the panel carries two permissions: `<module>.read` gates
 * route access and `<module>.manage|moderate|action` gates the row/page
 * actions. Acting on a module implies being able to open it, so the action key
 * always grants the read key.
 *
 * Without this, a hand-picked override set — or a role row seeded before
 * `categories.manage` / `announcements.manage` / `admins.manage` were split
 * into read + action — leaves an admin holding the buttons but not the route.
 */
const CATALOGUE_KEYS: ReadonlySet<string> = new Set(Object.values(PERMISSIONS));

export function withImpliedReads(keys: Iterable<string>): string[] {
  const effective = new Set(keys);
  for (const key of [...effective]) {
    const [group, action] = key.split(".");
    if (
      group &&
      (action === "manage" || action === "moderate" || action === "action")
    ) {
      const read = `${group}.read`;
      // Only keys the catalogue actually has: `settings.manage` has no page and
      // no `settings.read`, and inventing one puts a key in the effective set
      // that every catalogue-validated write (PATCH permissions) then rejects.
      if (CATALOGUE_KEYS.has(read)) effective.add(read);
    }
  }
  return [...effective];
}
