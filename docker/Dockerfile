############################################
# Base (runtime deps, shared by build + release)
# Inlined from Base.Dockerfile so multi-arch CI builds
# don't depend on a pre-pushed base image.
############################################
FROM node:22-bookworm-slim AS base
RUN apt update && apt install --yes --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    unzip \
    dumb-init \
    skopeo \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt --yes --no-install-recommends install \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

############################################
# Frontend Build
# Runs on the build platform, output is plain JS/CSS
############################################
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
# Retry once to work around the intermittent esbuild postinstall ETXTBSY
# race that can occur under Docker BuildKit (npm ci is idempotent).
RUN npm ci || npm ci
COPY frontend ./frontend
COPY backend ./backend
COPY common ./common
COPY tsconfig.json ./
RUN npm run build:frontend

############################################
# Healthcheck Binary
# Cross-compiled on the build platform
############################################
FROM --platform=$BUILDPLATFORM golang:1.21.4-bookworm AS build_healthcheck
WORKDIR /app
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Build (backend node_modules, target platform)
############################################
FROM base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev || npm ci --omit=dev

############################################
# ⭐ Main Image
############################################
FROM base AS release
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
