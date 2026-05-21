/** Mobile app version: `major.minor.patch` (e.g. 1.0.5). */
const APP_VERSION_PATTERN = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;

export type ParsedAppVersion = {
  major: number;
  minor: number;
  patch: number;
  canonical: string;
};

export function parseAppVersion(raw: string): ParsedAppVersion {
  const trimmed = raw.trim();
  const match = APP_VERSION_PATTERN.exec(trimmed);

  if (!match) {
    throw new Error("INVALID_APP_VERSION_FORMAT");
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  return {
    major,
    minor,
    patch,
    canonical: `${major}.${minor}.${patch}`,
  };
}
