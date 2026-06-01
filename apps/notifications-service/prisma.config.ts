import path from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// The Prisma CLI does not run src/config/env.ts, so compose MONGO_DATABASE_URL
// from the MONGO_* parts here too — lets `prisma generate` / `db push` resolve
// env("MONGO_DATABASE_URL") in schema.prisma when only the parts are in .env.
dotenv.config();

if (!process.env.MONGO_DATABASE_URL) {
  const user = encodeURIComponent(process.env.MONGO_ROOT_USERNAME ?? "");
  const pass = encodeURIComponent(process.env.MONGO_ROOT_PASSWORD ?? "");
  const host = process.env.MONGO_HOST ?? "localhost";
  const port = process.env.MONGODB_PORT ?? "27017";
  const dbName = process.env.MONGO_DB_NAME ?? "aimess_notifications";
  const authSource = process.env.MONGO_DATABASE ?? "admin";
  process.env.MONGO_DATABASE_URL =
    `mongodb://${user}:${pass}@${host}:${port}/${dbName}` +
    `?authSource=${authSource}&directConnection=true`;
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
});
