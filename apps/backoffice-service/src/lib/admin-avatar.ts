/** Fields needed to resolve an admin's avatar URL. */
export type AdminAvatarSource = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

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
  return "";
}
