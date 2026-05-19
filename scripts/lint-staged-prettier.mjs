/**
 * Prettier runner for lint-staged (avoids Windows "command line too long").
 * Usage: node scripts/lint-staged-prettier.mjs <file> [file...]
 */
import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

await Promise.all(
  files.map(async (file) => {
    const options = (await prettier.resolveConfig(file)) ?? {};
    const input = await readFile(file, "utf8");
    const output = await prettier.format(input, { ...options, filepath: file });
    if (output !== input) {
      await writeFile(file, output);
    }
  }),
);
