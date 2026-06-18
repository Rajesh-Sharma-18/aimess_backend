export interface ParseObjectKeyOptions {
  prefixes: readonly string[];
  bucket: string;
}

/**
 * Resolve a bare object key from a stored value that may be either an object
 * key or a legacy full URL. Centralizes the logic previously duplicated in
 * user-service avatar storage and community-service image storage (including
 * the user-service marker-scan fallback).
 */
export function parseObjectKeyFromStored(
  stored: string | null | undefined,
  opts: ParseObjectKeyOptions
): string | null {
  if (!stored) {
    return null;
  }

  for (const prefix of opts.prefixes) {
    if (stored.startsWith(`${prefix}/`)) {
      return stored;
    }
  }

  try {
    const pathname = new URL(stored).pathname;
    let key = pathname.startsWith("/") ? pathname.slice(1) : pathname;

    const bucketPrefix = `${opts.bucket}/`;
    if (key.startsWith(bucketPrefix)) {
      key = key.slice(bucketPrefix.length);
    }

    for (const prefix of opts.prefixes) {
      if (key.startsWith(`${prefix}/`)) {
        return key;
      }
    }

    // Marker-scan fallback: locate `/{prefix}/` anywhere in the path and
    // return the substring starting at that prefix.
    for (const prefix of opts.prefixes) {
      const markerIndex = pathname.indexOf(`/${prefix}/`);
      if (markerIndex >= 0) {
        return pathname.slice(markerIndex + 1);
      }
    }
  } catch {
    // Not a URL — ignore.
  }

  return null;
}

/**
 * Derive a fileId/ext pair from an object key by inspecting its basename.
 * Splits on the LAST `.`; does not validate UUID shape.
 */
export function parseFileMetaFromObjectKey(objectKey: string | null): {
  fileId: string | null;
  ext: string | null;
} {
  if (!objectKey) {
    return { fileId: null, ext: null };
  }

  const lastSlash = objectKey.lastIndexOf("/");
  const basename = lastSlash >= 0 ? objectKey.slice(lastSlash + 1) : objectKey;

  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex >= 0) {
    return {
      fileId: basename.slice(0, dotIndex),
      ext: basename.slice(dotIndex + 1).toLowerCase(),
    };
  }

  return { fileId: basename, ext: null };
}
