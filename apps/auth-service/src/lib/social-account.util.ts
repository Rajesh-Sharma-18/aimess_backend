import { authRepository } from "../repositories/auth.repository.js";

function sanitizeAccountBase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized.length < 3) {
    return normalized.padEnd(3, "_");
  }

  return normalized.slice(0, 24);
}

export function buildSocialAccountBase(
  provider: "google" | "apple",
  providerUserId: string,
  email: string | null | undefined
): string {
  if (email) {
    const local = email.split("@")[0] ?? "user";
    return sanitizeAccountBase(local);
  }

  return sanitizeAccountBase(`${provider}_${providerUserId.slice(0, 12)}`);
}

export async function generateUniqueAccount(base: string): Promise<string> {
  let candidate = sanitizeAccountBase(base).slice(0, 32);
  let suffix = 0;

  while (await authRepository.findByAccount(candidate)) {
    suffix += 1;
    const suffixText = `_${String(suffix)}`;
    candidate = `${sanitizeAccountBase(base).slice(0, 32 - suffixText.length)}${suffixText}`;
  }

  return candidate;
}
