import path from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// @ts-expect-error -- plain .mjs helper, no types; see the file for why.
import { unlockPrismaEngine } from "../../scripts/unlock-prisma-engines.mjs";

dotenv.config();

// Windows-only: move an engine DLL a running dev process has loaded out of the
// way, or generate dies with EPERM. No-op elsewhere.
unlockPrismaEngine(path.join(import.meta.dirname, "src", "generated", "prisma"));

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.STREAM_DATABASE_URL! },
});
