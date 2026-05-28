import { PrismaClient } from "../generated/prisma/client.js";
import {
  createPostgresPrismaClient,
  getOrCreatePostgresPrismaClient,
} from "@aimess/prisma-pg";

import { env } from "./env";
import { logger } from "@aimess/logger";

const GLOBAL_KEY = "prisma_auth_service";

export const prisma = getOrCreatePostgresPrismaClient(
  GLOBAL_KEY,
  env.NODE_ENV,
  () =>
    createPostgresPrismaClient({
      PrismaClient,
      connectionString: env.AUTH_DATABASE_URL,
      nodeEnv: env.NODE_ENV,
      logger,
    })
);
