import {
  createPostgresPrismaClient,
  getOrCreatePostgresPrismaClient,
} from "@aimess/prisma-pg";
import { logger } from "@aimess/logger";

import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

const GLOBAL_KEY = "prisma_backoffice_service";

export const prisma = getOrCreatePostgresPrismaClient(
  GLOBAL_KEY,
  env.NODE_ENV,
  () =>
    createPostgresPrismaClient({
      PrismaClient,
      connectionString: env.ADMIN_DATABASE_URL,
      nodeEnv: env.NODE_ENV,
      logger,
    })
);
