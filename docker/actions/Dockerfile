FROM node:22-alpine@sha256:4d64b49e6c891c8fc821007cb1cdc6c0db7773110ac2c34bf2e6960adef62ed3 AS deps
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npx turbo build --filter=manifest-shared --filter=manifest-backend

FROM node:22-alpine@sha256:4d64b49e6c891c8fc821007cb1cdc6c0db7773110ac2c34bf2e6960adef62ed3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BIND_ADDRESS=0.0.0.0
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1
CMD ["node", "packages/backend/dist/main.js"]
