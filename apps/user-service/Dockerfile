# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Define HTTP health checks in Compose/K8s (port from your env).
# Build from monorepo root:
#   docker build -f apps/user-service/Dockerfile -t aimess-user-service:latest .
#
# PRISMA_BUILD_DATABASE_URL is ONLY for `prisma generate` / compile during the image build.
# It is not your production database. Override with --build-arg if your tooling requires it.
#
# At runtime set real values per apps/user-service/.env.example (USER_DATABASE_URL, REDIS_*, etc.).

FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV CI=true
ENV HUSKY=0
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
COPY . .
ARG PRISMA_BUILD_DATABASE_URL=postgresql://prisma_build:prisma_build@127.0.0.1:5432/_prisma_placeholder
RUN export USER_DATABASE_URL="${PRISMA_BUILD_DATABASE_URL}" \
  && pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --filter=@aimess/user-service \
  && pnpm deploy --filter=@aimess/user-service --prod --legacy /out

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat \
  && addgroup -g 1001 app \
  && adduser -u 1001 -G app -s /sbin/nologin -D app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
USER app
ENV NODE_ENV=production
# Listen port: set `USER_SERVICE_PORT` at run time (see apps/user-service/.env.example).
EXPOSE 3002
CMD ["node", "dist/server.js"]
