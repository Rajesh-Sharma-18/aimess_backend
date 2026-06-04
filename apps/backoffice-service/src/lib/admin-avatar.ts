import { env } from "../config/env.js";

/** Fields needed to resolve an admin's avatar URL. */
export type AdminAvatarSource = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

/**
 * Builds the deterministic, system-generated default avatar URL for an admin
 * who has no custom avatar. Seeded by a stable value so the same admin always
 * gets the same avatar. Pure URL construction — no I/O, no stored file.
 */
function buildDefaultAdminAvatarUrl(seed: string): string {
  const base = env.ADMIN_DEFAULT_AVATAR_BASE_URL.replace(/\/$/, "");
  return `${base}?seed=${encodeURIComponent(seed)}`;
}

/**
 * Single source of truth for an admin's avatar URL, shared by login, refresh,
 * and GET /me. Returns the custom avatar when set, otherwise a system-generated
 * default — so the response always carries a valid, non-null `avatarUrl`.
 */
export function resolveAdminAvatarUrl(admin: AdminAvatarSource): string {
  const custom = admin.avatarUrl?.trim();
  if (custom) {
    return custom;
  }

  // Prefer the name so the default shows meaningful initials; fall back to the
  // id so the seed is always stable and unique.
  const seed = admin.name?.trim() || admin.id;
  return buildDefaultAdminAvatarUrl(seed);
}
