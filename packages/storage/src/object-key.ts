import { randomUUID } from "node:crypto";

export type BuildObjectKeyParams = {
  prefix: string;
  ownerId: string;
  ext: string;
  fileId?: string;
};

/** Object key: `{prefix}/{ownerId}/{fileId}.{ext}` (random fileId if absent). */
export function buildObjectKey(params: BuildObjectKeyParams): string {
  const safeExt = params.ext.replace(/^\./, "").toLowerCase();
  const fileId = params.fileId ?? randomUUID();
  return `${params.prefix}/${params.ownerId}/${fileId}.${safeExt}`;
}

/**
 * Ownership check — the key must live under `{prefix}/{ownerId}/` and must not
 * traverse out of its prefix.
 */
export function assertObjectKeyOwnedBy(
  objectKey: string,
  prefix: string,
  ownerId: string
): boolean {
  return (
    objectKey.startsWith(`${prefix}/${ownerId}/`) && !objectKey.includes("..")
  );
}
