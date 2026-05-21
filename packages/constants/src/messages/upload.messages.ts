import type { MessageCatalog } from "./types.js";

/** Generic upload (presigned URL) messages shared across services. */
export const UPLOAD_MESSAGES = {
  UPLOAD_UNSUPPORTED_CONTENT_TYPE: {
    vi: "Định dạng tệp không được hỗ trợ",
    en: "Unsupported file content type",
  },
  UPLOAD_FILE_TOO_LARGE: {
    vi: "Tệp vượt quá kích thước cho phép",
    en: "File exceeds the maximum allowed size",
  },
  UPLOAD_FILE_EMPTY: {
    vi: "Tệp trống, vui lòng chọn tệp hợp lệ",
    en: "File is empty",
  },
} as const satisfies MessageCatalog;

export type UploadMessageKey = keyof typeof UPLOAD_MESSAGES;
