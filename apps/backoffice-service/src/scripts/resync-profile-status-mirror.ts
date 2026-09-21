/**
 * One-off repair: re-send every moderated account's status to user-service.
 * See lib/profile-status-resync.ts for what and why. DRY RUN by default —
 * pass `--apply` to write. Exits non-zero if any write failed.
 *
 * Lives under src/ so `tsc` ships it as dist/scripts/*.js: the image carries
 * neither `tsx` (a devDependency) nor the top-level scripts/ folder, so a
 * script outside src/ cannot run where the deployed configuration lives.
 *
 * Configuration comes from the same environment the service boots with — never
 * paste values (keys especially) onto the command line.
 *
 * Local (reads apps/backoffice-service/.env via dotenv):
 *   pnpm --filter @aimess/backoffice-service db:resync:profile-status [-- --apply]
 *
 * Deployed (dev02) — compose's `env_file` parses multi-line quoted values;
 * `docker run --env-file` does NOT, and refuses the whole file before any
 * container is created:
 *   cd /opt/aimess/aimess_backend/deploy/dev02   # holds compose.yml + .env.dev02
 *   docker compose -f compose.yml --env-file .env.dev02 run --rm --no-deps \
 *     backoffice-service node dist/scripts/resync-profile-status-mirror.js [--apply]
 */
import { prisma } from "../config/prisma.js";
import { userClient } from "../grpc/user.client.js";
import { resyncProfileStatusMirror } from "../lib/profile-status-resync.js";

const { failed } = await resyncProfileStatusMirror(
  {
    findUserIndexPage: ({ cursor, take, statuses }) =>
      prisma.userIndex.findMany({
        where: { status: { in: statuses } },
        take,
        ...(cursor ? { skip: 1, cursor: { userId: cursor } } : {}),
        orderBy: { userId: "asc" },
        select: { userId: true, status: true },
      }),
    setProfileStatus: (userId, status) =>
      userClient.adminSetProfileStatus(userId, status),
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  },
  { apply: process.argv.includes("--apply") }
);

await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
