# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Build from monorepo root — required for pnpm workspaces:
#   docker build -f apps/notifications-service/Dockerfile -t aimess-notifications-service:latest .
#
# PRISMA_BUILD_DATABASE_URL is ONLY for `prisma generate` during the image build.
# It is not your production database — `generate` never opens a connection.
#
# At runtime set real values per apps/notifications-service/.env.example
# (MONGO_*, RABBITMQ_URL, REDIS_*, FIREBASE_*, APNS_*, SMTP_*).
#
# FIREBASE_PRIVATE_KEY / APNS_PRIVATE_KEY are multi-line PEM values — pass them
# through an env_file or a secret, never as a Dockerfile ARG/ENV.

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
  # Build shared packages then compile notifications-service (outputs to apps/notifications-service/dist/)
  && pnpm exec turbo run build --filter=@aimess/notifications-service \
  # Prisma generates its runtime client as .js files to src/generated/prisma/.
  # tsc only compiles .ts files, so we copy the client into dist/ manually so
  # that the relative import "../generated/prisma/index.js" resolves at runtime.
  && cp -r apps/notifications-service/src/generated apps/notifications-service/dist/generated \
  # Create a standalone deployment package (production node_modules + workspace deps).
  && pnpm deploy --filter=@aimess/notifications-service --prod --legacy /out \
  # `dist` is gitignored, so pnpm deploy omits it — copy explicitly.
  && cp -r apps/notifications-service/dist /out/dist

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat \
  && addgroup -g 1001 app \
  && adduser -u 1001 -G app -s /sbin/nologin -D app
WORKDIR /app
COPY --from=builder --chown=app:app /out/ .
USER app
ENV NODE_ENV=production
# Listen port: set `NOTIFICATIONS_SERVICE_PORT` at run time (see apps/notifications-service/.env.example).
EXPOSE 3006
CMD ["node", "dist/server.js"]
