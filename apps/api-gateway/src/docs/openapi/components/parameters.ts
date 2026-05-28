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
};
