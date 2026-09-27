FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=0.156.1
RUN npm install -g @openai/codex@${CODEX_VERSION}
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
RUN mkdir /data /repos && chown node:node /data /repos
USER node
ENV CODEXBRIDGE_HOME=/data
EXPOSE 3847
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["start"]
