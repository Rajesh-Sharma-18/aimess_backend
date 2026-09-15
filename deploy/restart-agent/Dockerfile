# Service restart agent — see server.mjs. No dependencies, no shell use.
#   docker build -t aimess-restart-agent:latest deploy/restart-agent
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
# Not root: socket access comes from group_add in compose.restart-agent.yml.
USER node
EXPOSE 8085
CMD ["node", "server.mjs"]
