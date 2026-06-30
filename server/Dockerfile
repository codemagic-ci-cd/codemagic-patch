# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Builder — installs all workspace deps and compiles the server to dist/.
# ---------------------------------------------------------------------------
FROM node:22.20.0-alpine AS builder

WORKDIR /workspace

ENV CI=1 \
    YARN_ENABLE_TELEMETRY=0

RUN corepack enable

RUN apk add --no-cache build-base python3 linux-headers

# Yarn workspace resolution needs every package's manifest. Copy manifests
# first so the install layer is cached when only source changes.
COPY package.json yarn.lock .yarnrc.yml ./
COPY cli/package.json ./cli/
COPY client/package.json ./client/
COPY infra/pulumi/package.json ./infra/pulumi/
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY web-dashboard/package.json ./web-dashboard/

RUN yarn install --immutable

COPY tsconfig.base.json ./
COPY server ./server

RUN yarn workspace @codemagic/patch-server build

# Trim devDependencies for the runtime image. `workspaces focus --production`
# rewrites node_modules with production-only deps for the focused workspace.
RUN yarn workspaces focus --production @codemagic/patch-server

# ---------------------------------------------------------------------------
# Runtime — minimal image carrying compiled JS + production deps + vendored
# hdiffpatch binaries the worker shells out to.
# ---------------------------------------------------------------------------
FROM node:22.20.0-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN addgroup -S codemagic-patch && adduser -S codemagic-patch -G codemagic-patch

COPY --from=builder --chown=codemagic-patch:codemagic-patch /workspace/node_modules ./node_modules
COPY --from=builder --chown=codemagic-patch:codemagic-patch /workspace/server/dist ./dist
COPY --from=builder --chown=codemagic-patch:codemagic-patch /workspace/server/vendor ./vendor
COPY --from=builder --chown=codemagic-patch:codemagic-patch /workspace/server/package.json ./package.json

USER codemagic-patch

EXPOSE 3000

CMD ["node", "dist/main.js"]
