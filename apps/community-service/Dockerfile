# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Build from monorepo root — required for pnpm workspaces:
#   docker build -f apps/community-service/Dockerfile -t aimess-community-service:latest .
#
# PRISMA_BUILD_DATABASE_URL is ONLY for `prisma generate` during the image build.
# It is not your production database — `generate` never opens a connection.
#
# At runtime set real values per apps/community-service/.env.example
# (COMMUNITY_DATABASE_URL, REDIS_*, RABBITMQ_URL, MINIO_*, JWT_ACCESS_SECRET).

FROM node:22-bookworm-slim AS builder
# openssl is required HERE, not just in the runner. `prisma generate` sniffs the
# libssl version to pick a query-engine binary; without it detection fails with
# "Prisma failed to detect the libssl/openssl version" and it silently defaults
# to openssl-1.1.x. Bookworm ships 3.0.x, so the container then dies at startup
# with "could not locate the Query Engine for runtime debian-openssl-3.0.x".
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && apt-get clean
WORKDIR /repo
ENV CI=true
ENV HUSKY=0
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
COPY . .
ARG PRISMA_BUILD_DATABASE_URL=mongodb://127.0.0.1:27017/_prisma_placeholder
RUN export COMMUNITY_DATABASE_URL="${PRISMA_BUILD_DATABASE_URL}" \
  && pnpm install --frozen-lockfile \
  # Build shared packages then compile community-service (outputs to apps/community-service/dist/)
  && pnpm exec turbo run build --filter=@aimess/community-service \
  # Prisma generates its runtime client as .js files to src/generated/prisma/.
  # tsc only compiles .ts files, so we copy the client into dist/ manually so
  # that the relative import "../generated/prisma/index.js" resolves at runtime.
  && cp -r apps/community-service/src/generated apps/community-service/dist/generated \
  # Create a standalone deployment package (production node_modules + workspace deps).
  && pnpm deploy --filter=@aimess/community-service --prod --legacy /out \
  # `dist` is gitignored, so pnpm deploy omits it — copy explicitly.
  && cp -r apps/community-service/dist /out/dist

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
# Listen port: set `COMMUNITY_SERVICE_PORT` at run time (see apps/community-service/.env.example).
EXPOSE 3003
CMD ["node", "dist/server.js"]
