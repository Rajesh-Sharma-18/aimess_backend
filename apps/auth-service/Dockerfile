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

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat \
  && addgroup -g 1001 app \
  && adduser -u 1001 -G app -s /sbin/nologin -D app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
USER app
ENV NODE_ENV=production
# Listen port: set `AUTH_SERVICE_PORT` at run time (see apps/auth-service/.env.example).
EXPOSE 3001
CMD ["node", "dist/server.js"]
