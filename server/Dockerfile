# ---------------------------------------------------------------------------
# Builder — installs all workspace deps and compiles the server to dist/.
#
# Uses only builder-agnostic Dockerfile syntax (no BuildKit-only features, no
# `# syntax=` frontend pin) so it builds on both BuildKit and the legacy
# builder without pulling a frontend image from Docker Hub.
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
COPY docs-site/package.json ./docs-site/
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY web-dashboard/package.json ./web-dashboard/

RUN yarn install --immutable

COPY tsconfig.base.json ./
COPY server ./server

RUN yarn workspace @codemagic/patch-server build

# The dashboard SPA ships inside the server image and is served by the app
# (DASHBOARD_STATIC_DIR), so one image is the whole release. Defaults to the
# same-origin API base, which is exactly the served topology. Must build
# before `workspaces focus` strips the dashboard's dev tooling.
COPY shared ./shared
COPY web-dashboard ./web-dashboard
RUN yarn workspace web-dashboard build

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
COPY --from=builder --chown=codemagic-patch:codemagic-patch /workspace/web-dashboard/dist ./dashboard

# Serve the bundled dashboard by default; unset to run API-only.
ENV DASHBOARD_STATIC_DIR=/app/dashboard

USER codemagic-patch

EXPOSE 3000

CMD ["node", "dist/main.js"]
