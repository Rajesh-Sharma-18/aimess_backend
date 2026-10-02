import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function keyBuffer(key: string): Buffer {
  return Buffer.from(key, "base64");
}

export function sealSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBuffer(key), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(":");
}

export function openSecret(sealed: string, key: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error("Unsupported sealed secret format");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    keyBuffer(key),
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
