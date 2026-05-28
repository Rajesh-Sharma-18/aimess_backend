/**
 * ESLint fix runner for lint-staged (avoids Windows "command line too long").
 * Usage: node scripts/lint-staged-eslint.mjs <file> [file...]
 */
import { ESLint } from "eslint";

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

const eslint = new ESLint({ fix: true });
const results = await eslint.lintFiles(files);
await ESLint.outputFixes(results);

const failed = results.filter((result) => result.errorCount > 0);
if (failed.length === 0) process.exit(0);

const formatter = await eslint.loadFormatter("stylish");
console.error(formatter.format(failed));
process.exit(1);
