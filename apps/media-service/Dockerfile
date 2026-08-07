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

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat \
  && addgroup -g 1001 app \
  && adduser -u 1001 -G app -s /sbin/nologin -D app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
USER app
ENV NODE_ENV=production
# Listen port: set `MEDIA_SERVICE_PORT` at run time (see apps/media-service/.env.example).
EXPOSE 3009
CMD ["node", "dist/server.js"]
