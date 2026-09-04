import { logger } from "@aimess/logger";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/db.js";
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
  LivestreamViewerSessionRepository,
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

// -- Events --
import { publishStreamEvent } from "./events/index.js";

// -- Controllers --
import { StreamController } from "./api/controllers/index.js";

// -- Jobs --
import { startStreamSweeper } from "./jobs/stream-sweeper.js";

async function start() {
  try {
    await connectDatabase();

    // Sparse unique index on Livestream.playbackId — enforces uniqueness for
    // real playback ids while letting every legacy row (created before the
    // streamKey/playbackId split, so carrying none) coexist. Prisma cannot
    // express sparse indexes for MongoDB, and a plain `@unique` cannot be built
    // at all once more than one row lacks the field. Idempotent: createIndexes
    // is a no-op when the index already exists with the same options.
    try {
      await prisma.$runCommandRaw({
        createIndexes: "livestreams",
        indexes: [
          {
            key: { playbackId: 1 },
            name: "livestreams_playbackId_unique_sparse",
            unique: true,
            sparse: true,
          },
        ],
      });
      logger.info("Index ready: livestreams.playbackId (sparse unique)");
    } catch (indexErr) {
      logger.warn(
        "Could not create playbackId sparse index — playback ids may lack uniqueness enforcement"
      );
      logger.warn(indexErr);
    }

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
    const viewerSessionRepo = new LivestreamViewerSessionRepository(prisma);

    // 2. Services (inject repos + clients + redis)
    const srsService = new SrsService();
    const livestreamService = new LivestreamService(
      streamRepo,
      srsService,
      communityGrpcClient,
      redis,
      banRepo,
      viewerSessionRepo,
      publishStreamEvent,
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
