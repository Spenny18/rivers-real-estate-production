# Multi-stage build for the Rivers Real Estate platform.
# - Stage 1 builds the client (Vite) and the server bundle (esbuild).
# - Stage 2 is a slim runtime image with only what's needed to run dist/index.cjs.

# ---- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# better-sqlite3 needs a C++ toolchain + python to compile its native binding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for cache-friendly layers.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the source and build.
COPY . .
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# qpdf strips the owner-password encryption CREA WEBForms puts on exported
# PDFs so signatures can be stamped onto them (server/pdf-decrypt.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends qpdf \
 && rm -rf /var/lib/apt/lists/*

# Bring in only what the server bundle needs at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Copy the built server bundle and the static frontend.
COPY --from=builder /app/dist ./dist

# Persistent volume for the SQLite database lives at /data — see fly.toml.
RUN mkdir -p /data
ENV DB_PATH=/data/rivers.db

EXPOSE 8080

CMD ["node", "dist/index.cjs"]
