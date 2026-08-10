# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Define HTTP health checks in Compose/K8s (port/path from your env).
# Build from monorepo root:
#   docker build -f apps/auth-service/Dockerfile -t aimess-auth-service:latest .
#
# PRISMA_BUILD_DATABASE_URL is ONLY for `prisma generate` / compile during the image build.
# It is not your production database. Prisma does not need a live server for `generate`.
# Override at build time if required: --build-arg PRISMA_BUILD_DATABASE_URL=postgresql://...
#
# At runtime set real secrets + networking via apps/auth-service/.env.example (AUTH_DATABASE_URL,
# REDIS_*, JWT_*, etc.).

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
# Prisma reads AUTH_DATABASE_URL from the environment — set only for this RUN (no ENV),
# so BuildKit does not warn about "secrets in ENV". Value is a non-prod placeholder for `generate` only.
ARG PRISMA_BUILD_DATABASE_URL=postgresql://prisma_build:prisma_build@127.0.0.1:5432/_prisma_placeholder
RUN export AUTH_DATABASE_URL="${PRISMA_BUILD_DATABASE_URL}" \
  && pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --filter=@aimess/auth-service \
  && pnpm deploy --filter=@aimess/auth-service --prod --legacy /out

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
# Listen port: set `AUTH_SERVICE_PORT` at run time (see apps/auth-service/.env.example).
EXPOSE 3001
CMD ["node", "dist/server.js"]
