import { createHash, randomBytes } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createRefreshTokenValue(): string {
  return randomBytes(48).toString("base64url");
}
