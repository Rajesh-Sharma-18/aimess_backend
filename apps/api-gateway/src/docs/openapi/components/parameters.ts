import { DEFAULT_LOCALE } from "@aimess/constants";

export const openApiParameters = {
  LanguageHeader: {
    name: "x-lang",
    in: "header",
    description: `Preferred response language (\`en\`, \`vi\` or \`th\`). Falls back to Accept-Language, then ${DEFAULT_LOCALE === "vi" ? "Vietnamese" : "English"}. Applies to every localizable \`message\`/\`error.message\` in the response, and is forwarded to downstream services (and their SYSTEM message text) as-is.`,
    required: false,
    schema: {
      type: "string",
      enum: ["en", "vi", "th"],
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
