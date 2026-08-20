import { PERMISSIONS } from "../constants/index.js";

/**
 * Each module carries up to three keys: `<module>.read` (enter module, see
 * list), `<module>.view` (open detail/conversation/player), and
 * `<module>.manage|moderate|action` (destructive actions). The higher key
 * always implies the lower ones — so an edit grant alone still lets the admin
 * open the module, and a view grant alone still lets them enter it.
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
    if (!group) continue;
    if (action === "manage" || action === "moderate" || action === "action") {
      // Edit implies view + read (where the catalogue defines them; settings
      // has neither, so nothing gets invented that a catalogue-validated
      // PATCH would then reject).
      const view = `${group}.view`;
      const read = `${group}.read`;
      if (CATALOGUE_KEYS.has(view)) effective.add(view);
      if (CATALOGUE_KEYS.has(read)) effective.add(read);
    } else if (action === "view") {
      const read = `${group}.read`;
      if (CATALOGUE_KEYS.has(read)) effective.add(read);
    }
  }
  return [...effective];
}
