const HANDLE_MIN_LENGTH = 3;
const HANDLE_MAX_LENGTH = 32;
/** Canonical handles are stored lowercase so uniqueness matches user expectations. */
const HANDLE_PATTERN = /^[a-z0-9_]+$/;

const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 50;

/** Trim + lowercase a community handle — call before format checks and DB lookups. */
export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function isValidHandleFormat(handle: string): boolean {
  const normalized = normalizeHandle(handle);
  return (
    normalized.length >= HANDLE_MIN_LENGTH &&
    normalized.length <= HANDLE_MAX_LENGTH &&
    HANDLE_PATTERN.test(normalized)
  );
}

/** Trim a community display name (kept as-entered, casing preserved). */
export function normalizeName(name: string): string {
  return name.trim();
}

export function isValidNameLength(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    normalized.length >= NAME_MIN_LENGTH && normalized.length <= NAME_MAX_LENGTH
  );
}

/** Derive a kebab-case slug for a category from its display name. */
export function slugifyCategoryName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
