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
