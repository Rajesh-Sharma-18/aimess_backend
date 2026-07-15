import { DEFAULT_LOCALE } from "@aimess/constants";

export const openApiParameters = {
  LanguageHeader: {
    name: "x-lang",
    in: "header",
    description: `Preferred response language (\`vi\` or \`en\`). Falls back to Accept-Language, then ${DEFAULT_LOCALE === "vi" ? "Vietnamese" : "English"}.`,
    required: false,
    schema: {
      type: "string",
      enum: ["vi", "en"],
      default: DEFAULT_LOCALE,
    },
    example: DEFAULT_LOCALE,
  },
  PlatformHeader: {
    name: "x-platform",
    in: "header",
    description:
      "Client platform, used to classify the created session's `deviceType`. Takes priority over User-Agent sniffing when present and recognized; falls back to User-Agent parsing otherwise.",
    required: false,
    schema: {
      type: "string",
      enum: ["android", "ios", "web", "windows", "macos", "linux"],
    },
    example: "android",
  },
};
