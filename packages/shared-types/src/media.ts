export interface MediaObject {
  /** Stable, immutable media identity (media-service MediaFile._id), independent of objectKey/url. Null for legacy/unregistered media. */
  mediaId: string | null;
  fileId: string | null;
  objectKey: string | null;
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  downloadUrl: string | null;
  downloadUrlExpiresIn: number | null;
  uploadUrl: string | null;
  uploadUrlExpiresIn: number | null;
  uploadHeaders?: Record<string, string>;
}
