# ─── Stage 1: Build the React/Vite client ───────────────────────────────────
FROM node:22-alpine AS client-builder

# URL of the API the browser should hit (must match how users open the app).
# Passed in from docker-compose `build.args.VITE_AUDIO_API`.
ARG VITE_AUDIO_API=""
ENV VITE_AUDIO_API=$VITE_AUDIO_API

WORKDIR /build/client
COPY client/package*.json ./
# Retry: under QEMU emulation OpenSSL's AES-GCM can intermittently corrupt the
# TLS stream to the npm registry (ERR_SSL_CIPHER_OPERATION_FAILED). The failure
# is flaky, so a couple of retries reliably gets a clean run. Root cause is the
# emulator — update host QEMU (`tonistiigi/binfmt --install all`) and/or build
# the native platform only to avoid it entirely.
RUN npm ci || npm ci || npm ci
COPY client/ ./
RUN npm run build          # outputs to /build/client/dist


# ─── Stage 2: Build the TypeScript server ────────────────────────────────────
FROM node:22-alpine AS server-builder

WORKDIR /build/server
COPY server/package*.json ./
# See client stage: retry guards against flaky AES-GCM/TLS failures under QEMU.
RUN npm ci || npm ci || npm ci
COPY server/ ./
RUN npm run build          # outputs to /build/server/dist


# ─── Stage 3: Production image ───────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for security
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Install only production dependencies
COPY server/package*.json ./server/
# See client stage: retry guards against flaky AES-GCM/TLS failures under QEMU.
RUN cd server && { npm ci --omit=dev || npm ci --omit=dev || npm ci --omit=dev; }

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
RUN apk add --no-cache su-exec espeak-ng

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
