# ─── Stage 1: Build the React/Vite client ───────────────────────────────────
FROM node:22-alpine AS client-builder

WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build          # outputs to /build/client/dist


# ─── Stage 2: Build the TypeScript server ────────────────────────────────────
FROM node:22-alpine AS server-builder

WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build          # outputs to /build/server/dist


# ─── Stage 3: Production image ───────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for security
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Install only production dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy compiled server
COPY --from=server-builder /build/server/dist ./server/dist

# Copy built client so the server can serve it as static files
COPY --from=client-builder /build/client/dist ./client/dist

# Create the cache directory the app user can write to
RUN mkdir -p /data/cache && chown -R app:app /data

# Expose the server port (override via PORT env var if needed)
EXPOSE 3001

ENV NODE_ENV=production
ENV CACHE_DIR=/data/cache

USER app

CMD ["node", "server/dist/index.js"]
