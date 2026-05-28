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

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat \
    && addgroup -g 1001 app \
    && adduser -u 1001 -G app -s /sbin/nologin -D app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
USER app
ENV NODE_ENV=production
# Listen port: set `PORT` at run time (see apps/api-gateway/.env.example).
EXPOSE 3000
CMD ["node", "dist/server.js"]
