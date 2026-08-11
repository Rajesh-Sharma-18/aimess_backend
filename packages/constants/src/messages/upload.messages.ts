import type { MessageCatalog } from "./types.js";

/** Generic upload (presigned URL) messages shared across services. */
export const UPLOAD_MESSAGES = {
  UPLOAD_UNSUPPORTED_CONTENT_TYPE: {
    vi: "Định dạng tệp không được hỗ trợ",
    en: "Unsupported file content type",
    th: "ไม่รองรับไฟล์ประเภทนี้",
  },
  UPLOAD_FILE_TOO_LARGE: {
    vi: "Tệp vượt quá kích thước cho phép",
    en: "File exceeds the maximum allowed size",
    th: "ไฟล์มีขนาดเกินกว่าที่กำหนด",
  },
  UPLOAD_FILE_EMPTY: {
    vi: "Tệp trống, vui lòng chọn tệp hợp lệ",
    en: "File is empty",
    th: "ไฟล์ว่างเปล่า",
  },
} as const satisfies MessageCatalog;

export type UploadMessageKey = keyof typeof UPLOAD_MESSAGES;
