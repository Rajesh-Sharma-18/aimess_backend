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

/**
 * Extract the owner id from an object key shaped `{prefix}/{ownerId}/{fileId}.{ext}`
 * — i.e. the 2nd path segment. Returns null when the key is malformed, empty, or
 * contains a `..` traversal segment so callers never act on a spoofed owner.
 */
export function extractOwnerIdFromObjectKey(objectKey: string): string | null {
  if (!objectKey || objectKey.includes("..")) {
    return null;
  }
  const ownerId = objectKey.split("/")[1];
  if (!ownerId) {
    return null;
  }
  return ownerId;
}
