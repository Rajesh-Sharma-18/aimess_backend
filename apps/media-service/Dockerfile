# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Build from monorepo root — required for pnpm workspaces:
#   docker build -f apps/media-service/Dockerfile -t aimess-media-service:latest .
#
# PRISMA_BUILD_DATABASE_URL is ONLY for `prisma generate` during the image build.
# It is not your production database — `generate` never opens a connection.
#
# At runtime set real values per apps/media-service/.env.example
# (MONGO_*, MINIO_*, REDIS_*/BULL_REDIS_*, CLAMAV_*, JWT_*).
#
# ClamAV runs as a SEPARATE container (see docker-compose) — this image only
# speaks to clamd over TCP at CLAMAV_HOST:CLAMAV_PORT. Do not install it here.

FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV CI=true
ENV HUSKY=0
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
COPY . .
ARG PRISMA_BUILD_DATABASE_URL=mongodb://127.0.0.1:27017/_prisma_placeholder
RUN export MONGO_DATABASE_URL="${PRISMA_BUILD_DATABASE_URL}" \
  && pnpm install --frozen-lockfile \
  # Build shared packages then compile media-service (outputs to apps/media-service/dist/)
  && pnpm exec turbo run build --filter=@aimess/media-service \
  # Prisma generates its runtime client as .js files to src/generated/prisma/.
  # tsc only compiles .ts files, so we copy the client into dist/ manually so
  # that the relative import "../generated/prisma/index.js" resolves at runtime.
  && cp -r apps/media-service/src/generated apps/media-service/dist/generated \
  # Create a standalone deployment package (production node_modules + workspace deps).
  && pnpm deploy --filter=@aimess/media-service --prod --legacy /out \
  # `dist` is gitignored, so pnpm deploy omits it — copy explicitly.
  && cp -r apps/media-service/dist /out/dist

# Debian, not Alpine. Prisma generates its query engine during the BUILD stage
# against that stage's libc; a musl runner then fails at startup with
# "could not locate the Query Engine for runtime linux-musl-openssl-3.0.x".
# Matching the builder's base keeps the engine ABI-compatible.
FROM node:22-bookworm-slim AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && apt-get clean \
  && find /var/lib/apt/lists -type f -delete \
  && groupadd -g 1001 app \
  && useradd -u 1001 -g app -s /usr/sbin/nologin -M app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
# The compiled gRPC code resolves .proto paths relative to __dirname, which from
# /app/dist/grpc[/clients] walks up past / and lands on /packages/... . Those
# files live in a workspace package that `pnpm deploy` does not carry over, so
# without this every service dies at startup with ENOENT on a .proto file.
COPY --from=builder /repo/packages/grpc-contracts/proto /packages/grpc-contracts/proto
USER app
ENV NODE_ENV=production
# Listen port: set `MEDIA_SERVICE_PORT` at run time (see apps/media-service/.env.example).
EXPOSE 3009
CMD ["node", "dist/server.js"]
