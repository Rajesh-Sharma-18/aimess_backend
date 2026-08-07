# syntax=docker/dockerfile:1
#
# Production-oriented image (multi-stage, non-root).
# Build from monorepo root:
#   docker build -f apps/chat-service/Dockerfile -t aimess/chat-service:latest .
#
# At runtime set real secrets + networking via apps/chat-service/.env.example
# (MONGODB_URI, REDIS_*, JWT_*, etc.).

FROM node:22-bookworm-slim AS builder
WORKDIR /repo
ENV CI=true
ENV HUSKY=0
ENV NODE_ENV=development
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
  # Build shared packages then compile chat-service (outputs to apps/chat-service/dist/)
  && pnpm exec turbo run build --filter=@aimess/chat-service \
  # Prisma generates its runtime client as .js files to src/generated/prisma/.
  # tsc only compiles .ts files, so we copy the client into dist/ manually so
  # that the relative import "../generated/prisma/index.js" resolves at runtime.
  && cp -r apps/chat-service/src/generated apps/chat-service/dist/generated \
  # Create a standalone deployment package (production node_modules + workspace deps).
  && pnpm deploy --filter=@aimess/chat-service --prod --legacy /out \
  # pnpm deploy may omit dist/ when gitignore excludes it — copy explicitly.
  && cp -r apps/chat-service/dist /out/dist

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
# Listen port: set `CHAT_SERVICE_PORT` at run time (see apps/chat-service/.env.example).
EXPOSE 3004
CMD ["node", "dist/server.js"]
