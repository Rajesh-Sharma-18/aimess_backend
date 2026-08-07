# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Define HTTP health checks in Compose/K8s (port from your env).
# Build from monorepo root — required for pnpm workspaces:
#   docker build -f apps/api-gateway/Dockerfile -t aimess-api-gateway:latest .
#
# This service does not use Prisma; do not set database URLs here.
# At runtime set: PORT, AUTH_GRPC_URL, USER_GRPC_URL, REDIS_URL, CORS_ALLOWED_ORIGINS
# (see apps/api-gateway/.env.example). Inject secrets via orchestrator / env, not ARG.

FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV CI=true
ENV HUSKY=0
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm exec turbo run build --filter=@aimess/api-gateway \
    && pnpm deploy --filter=@aimess/api-gateway --prod --legacy /out

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
# Listen port: set `PORT` at run time (see apps/api-gateway/.env.example).
EXPOSE 3000
CMD ["node", "dist/server.js"]
