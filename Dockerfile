# ─── Why the build stages pin $BUILDPLATFORM ─────────────────────────────────
# CI builds linux/amd64 and linux/arm64 (the Pi) on an amd64 runner, so every
# step of an arm64 stage runs under QEMU — npm ci, Vite, tsc, all of it, tens of
# times slower and flaky (the AES-GCM retries below, and on 2026-10-10 a build
# that sat in the emulated stage for the full six hours). None of it needs to:
# the client bundle, the compiled server and the server's production
# node_modules are plain JavaScript, identical for both platforms. So those
# three stages run on the runner's own platform, once, and the arm64 image only
# emulates its last few lines (adduser, apk add). On a box building for itself
# BUILDPLATFORM is the target, and nothing changes.

# ─── Stage 1: Build the React/Vite client ───────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS client-builder

# URL of the API the browser should hit (must match how users open the app).
# Passed in from docker-compose `build.args.VITE_AUDIO_API`.
ARG VITE_AUDIO_API=""
ENV VITE_AUDIO_API=$VITE_AUDIO_API

WORKDIR /build/client
COPY client/package*.json ./
# Retry: under QEMU emulation OpenSSL's AES-GCM can intermittently corrupt the
# TLS stream to the npm registry (ERR_SSL_CIPHER_OPERATION_FAILED). These stages
# no longer run emulated in CI (see the top of the file), but a builder without
# BuildKit's platform args would still emulate them, and a retry costs nothing.
RUN npm ci || npm ci || npm ci
COPY client/ ./
RUN npm run build          # outputs to /build/client/dist


# ─── Stage 2: Build the TypeScript server ────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS server-builder

WORKDIR /build/server
COPY server/package*.json ./
# See client stage: retry guards against flaky AES-GCM/TLS failures under QEMU.
RUN npm ci || npm ci || npm ci
COPY server/ ./
RUN npm run build          # outputs to /build/server/dist


# ─── Stage 3: The server's production dependencies ───────────────────────────
# Installed natively and copied into the image, which is only right while none
# of them is a native addon: an amd64 .node file in an arm64 image would fail
# at require() on the Pi. The check makes that a build failure instead — if it
# fires, move this `npm ci --omit=dev` back into the production stage.
FROM --platform=$BUILDPLATFORM node:22-alpine AS server-deps

WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci --omit=dev || npm ci --omit=dev || npm ci --omit=dev
RUN if find node_modules -name '*.node' | grep -q .; then \
      echo "A production dependency ships a native addon; it can't be installed on the build platform for every target:" >&2; \
      find node_modules -name '*.node' >&2; exit 1; \
    fi


# ─── Stage 4: Production image ───────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for security
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Production dependencies, installed natively in the stage above
COPY server/package*.json ./server/
COPY --from=server-deps /build/server/node_modules ./server/node_modules

# Copy compiled server
COPY --from=server-builder /build/server/dist ./server/dist

# Copy built client so the server can serve it as static files
COPY --from=client-builder /build/client/dist ./client/dist

# Create the cache directory the app user can write to
RUN mkdir -p /data/cache && chown -R app:app /data

# Startup script — fixes volume permissions then drops to app user.
# Only /data/cache is chowned: /data/avatar is a read-only bind mount of the
# host's model files, and chowning it fails noisily on every boot for no reason.
RUN printf '#!/bin/sh\nchown -R app:app /data/cache\nexec su-exec app node server/dist/index.js\n' > /entrypoint.sh \
    && chmod +x /entrypoint.sh

# su-exec   — drop privileges (Alpine equivalent of gosu)
# espeak-ng — server-side text-to-speech for /api/tts
#             (TouchKio/Electron does NOT implement Web Speech API,
#              so synthesis must happen server-side and be played as WAV)
# openssh-client — Settings → Server reaches the host over SSH with a key it
#             generates itself (server/src/host.ts); ssh + ssh-keygen are all
#             it needs, and both are in this one package.
RUN apk add --no-cache su-exec espeak-ng openssh-client

# Expose the server port (override via PORT env var if needed)
EXPOSE 3001

ENV NODE_ENV=production
ENV CACHE_DIR=/data/cache

# ─── Version stamp ───────────────────────────────────────────────────────────
# With Watchtower silently swapping images underneath it, "what is actually
# running right now?" is otherwise unanswerable from the device itself. These
# two facts let the Debug tab say so, and compare against the repo's HEAD.
#
# GIT_SHA is a build arg: CI always passes it (see docker-publish.yml). A local
# `docker compose build app` only gets it if you export it first —
#   GIT_SHA=$(git rev-parse HEAD) docker compose build app
# — and reports "unknown" otherwise, which is honest rather than wrong.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

# BUILD_TIME needs no cooperation from the caller, so it's the fallback that
# always works: a build is out of date if it predates the newest commit. It sits
# after the COPY steps deliberately — those layers change whenever the app does,
# so the timestamp is re-evaluated on every real build but stays put (correctly)
# when the whole image is a cache hit and genuinely IS the older build.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.build-time

CMD ["/entrypoint.sh"]
