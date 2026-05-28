import type { SupportedLocale } from "../locale.js";

export type LocalizedText = Record<SupportedLocale, string>;

export type MessageCatalog = Record<string, LocalizedText>;
