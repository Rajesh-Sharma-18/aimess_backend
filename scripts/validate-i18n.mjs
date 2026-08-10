#!/usr/bin/env node
/**
 * Translation catalog gate. Run standalone (`pnpm validate:i18n`) or via the
 * jest suite (`apps/api-gateway/tests/i18n/catalog-parity.test.ts`, same rules).
 *
 * TypeScript already enforces KEY PARITY: `LocalizedText` is
 * `Record<SupportedLocale, string>`, so a key missing `th` is a compile error,
 * not a runtime surprise. What the type CANNOT see is what this checks:
 *
 *   1. blank / whitespace-only values (a "present" key that renders as nothing)
 *   2. placeholder drift — `{{name}}` in `en` but not in `vi`/`th`, which
 *      silently drops the interpolated value from that language only
 *   3. an untranslated copy-paste (`th` byte-identical to `en`), which is how a
 *      catalog quietly stops being multilingual
 *
 * Exits non-zero with a per-key report on any violation.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MESSAGES, SUPPORTED_LOCALES } = require("../packages/constants/dist/index.js");

/** Keys whose text is legitimately identical across languages. */
const IDENTICAL_ALLOWED = new Set([
  // Pure structure — every token is a parameter.
  "SYS_COMMUNITY_LIVESTREAM_ENDED_DURATION",
  "NOTIF_CHAT_COMMUNITY_BODY",
]);

const placeholders = (text) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(",");

const errors = [];
const counts = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, 0]));

for (const [key, entry] of Object.entries(MESSAGES)) {
  for (const locale of SUPPORTED_LOCALES) {
    const value = entry[locale];
    if (typeof value !== "string") {
      errors.push(`${key}: missing "${locale}"`);
      continue;
    }
    counts[locale] += 1;
    if (!value.trim()) errors.push(`${key}.${locale}: blank`);
  }

  const reference = placeholders(entry.en ?? "");
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === "en") continue;
    const actual = placeholders(entry[locale] ?? "");
    if (actual !== reference) {
      errors.push(
        `${key}.${locale}: placeholders [${actual}] != en [${reference}]`
      );
    }
  }

  if (IDENTICAL_ALLOWED.has(key)) continue;
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === "en") continue;
    if (entry[locale] === entry.en) {
      errors.push(`${key}.${locale}: identical to en (untranslated?)`);
    }
  }
}

const total = Object.keys(MESSAGES).length;
const summary = SUPPORTED_LOCALES.map((l) => `${l}=${counts[l]}`).join(" ");
console.log(`i18n catalog: ${total} keys — ${summary}`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("i18n catalog OK");
