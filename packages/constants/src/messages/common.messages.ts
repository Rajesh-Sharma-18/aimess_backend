import type { MessageCatalog } from "./types.js";

/** Shared messages used across services. */
export const COMMON_MESSAGES = {
  VALIDATION_FAILED: {
    vi: "Dữ liệu không hợp lệ",
    en: "Validation failed",
  },
  INTERNAL_SERVER_ERROR: {
    vi: "Lỗi máy chủ nội bộ",
    en: "Internal server error",
  },
} as const satisfies MessageCatalog;

export type CommonMessageKey = keyof typeof COMMON_MESSAGES;
