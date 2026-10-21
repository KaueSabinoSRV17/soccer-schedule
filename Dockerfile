FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm test
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SOCCER_TIMEZONE=America/Sao_Paulo
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
RUN mkdir -p /app/out /app/data && chown node:node /app/out /app/data

USER node
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["--full-calendar-sync"]
