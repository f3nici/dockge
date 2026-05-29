############################################
# Frontend Build
############################################
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
COPY backend ./backend
COPY common ./common
COPY tsconfig.json ./
RUN npm run build:frontend

############################################
# Healthcheck Binary
############################################
FROM louislam/dockge:build-healthcheck AS build_healthcheck

############################################
# Build
############################################
FROM louislam/dockge:base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev

############################################
# ⭐ Main Image
############################################
FROM louislam/dockge:base AS release
WORKDIR /app

# Refresh the bundled Docker CLI / Compose plugin.
# The base image installs these unpinned, so they freeze at whatever was
# current when the base image was last built (e.g. docker-ce-cli 24.0.7).
# Old clients call netip.ParseAddr on IPv6 ULA gateways like
# "fdd0:0:0:5::1/64" (instead of ParsePrefix), which modern engines
# auto-assign, producing a "ParseAddr ... unexpected character, want colon"
# error. Upgrading to the current client (>= 27.x) fixes this.
# The Docker apt repo is already configured in the base image.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends --only-upgrade \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Copy healthcheck
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck

# Copy node modules
COPY --from=build /app/node_modules /app/node_modules

# Copy frontend build
COPY --chown=node:node --from=frontend-build /app/frontend-dist /app/frontend-dist

# Copy backend source
COPY --chown=node:node ./backend ./backend
COPY --chown=node:node ./common ./common
COPY --chown=node:node ./package.json ./
RUN mkdir ./data


# It is just for safe, as by default, it is disabled in the latest Node.js now.
# Read more:
# - https://github.com/sagemathinc/cocalc/issues/6963
# - https://github.com/microsoft/node-pty/issues/630#issuecomment-1987212447
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
#FROM release AS nightly
#RUN npm run mark-as-nightly
