import { logger } from "@aimess/logger";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import {
  connectStreamRedis,
  disableStreamCache,
  redis,
} from "./config/redis.js";
import { startGrpcServer } from "./grpc/server.js";

// -- Repositories --
import {
  LivestreamRepository,
  LivestreamCommentRepository,
  LivestreamBanRepository,
  LivestreamCommentReportRepository,
} from "./repositories/index.js";

// -- Services --
import {
  SrsService,
  LivestreamService,
  LivestreamCommentService,
} from "./services/index.js";

// -- gRPC clients --
import { userGrpcClient } from "./grpc/user.client.js";
import { communityGrpcClient } from "./grpc/community.client.js";

// -- Controllers --
import { StreamController } from "./api/controllers/index.js";

// -- Jobs --
import { startStreamSweeper } from "./jobs/stream-sweeper.js";

async function start() {
  try {
    await prisma.$connect();
    logger.info("MongoDB connected");

    if (env.REDIS_CACHE_ENABLED) {
      try {
        await connectStreamRedis();
        logger.info("Redis connected (caching enabled)");
      } catch (error) {
        disableStreamCache();
        logger.warn(
          "Redis unavailable — stream-service will run without caching"
        );
        logger.warn(error);
      }
    }

    // 1. Repositories (inject Prisma client)
    const streamRepo = new LivestreamRepository(prisma);
    const commentRepo = new LivestreamCommentRepository(prisma);
    const banRepo = new LivestreamBanRepository(prisma);
    const commentReportRepo = new LivestreamCommentReportRepository(prisma);

    // 2. Services (inject repos + clients + redis)
    const srsService = new SrsService();
    const livestreamService = new LivestreamService(
      streamRepo,
      srsService,
      communityGrpcClient,
      redis,
      banRepo,
      userGrpcClient
    );
    const commentService = new LivestreamCommentService(
      commentRepo,
      streamRepo,
      userGrpcClient,
      redis,
      banRepo,
      communityGrpcClient,
      commentReportRepo
    );

    // 3. Controllers
    const controller = new StreamController(livestreamService, commentService);

    // 4. gRPC server with real service delegates
    startGrpcServer(env.STREAM_GRPC_PORT, {
      commentService,
      livestreamService,
    });

    // 5. Express app (routes built with the injected controller + service)
    const app = createApp({ controller, livestreamService });

    app.listen(env.STREAM_SERVICE_PORT, "0.0.0.0", () => {
      logger.info(
        "Stream Service listening on port " + String(env.STREAM_SERVICE_PORT)
      );
    });

    // 6. Background jobs
    startStreamSweeper(livestreamService);
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

void start();
