import { PrismaClient } from "../generated/prisma/client.js";
import {
  createPostgresPrismaClient,
  getOrCreatePostgresPrismaClient,
} from "@aimess/prisma-pg";

import { logger } from "@aimess/logger";
import { env } from "./env.js";

const GLOBAL_KEY = "prisma_user_service";

export const prisma = getOrCreatePostgresPrismaClient(
  GLOBAL_KEY,
  env.NODE_ENV,
  () =>
    createPostgresPrismaClient({
      PrismaClient,
      connectionString: env.USER_DATABASE_URL,
      nodeEnv: env.NODE_ENV,
      logger,
    })
);
