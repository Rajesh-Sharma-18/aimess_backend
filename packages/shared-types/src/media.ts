export interface MediaObject {
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
