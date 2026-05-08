# ── Stage 1: build the frontend ────────────────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /app

# Copy lockfile + manifest first to maximise Docker layer cache hits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate \
 && pnpm install --frozen-lockfile

# Copy the rest of the frontend sources and build.
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts \
     postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src
RUN pnpm build

# ── Stage 2: build the headless server binary ─────────────────────────────
FROM rust:1.83-bookworm AS server
WORKDIR /build

# System deps: keyring crate isn't used by the server feature, but rcgen +
# tokio still need a real toolchain. `pkg-config` and `libssl-dev` cover the
# common transitive needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY src-tauri ./src-tauri

# We only need the `baseport-server` binary. The Tauri lib still gets compiled
# (it's the same crate) — that's fine, it's the source of all shared types.
WORKDIR /build/src-tauri
RUN cargo build --release --bin baseport-server --features server

# ── Stage 3: minimal runtime image ─────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates docker.io openssh-client curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash baseport

USER baseport
WORKDIR /home/baseport

# Copy artefacts.
COPY --from=server  /build/src-tauri/target/release/baseport-server /usr/local/bin/baseport-server
COPY --from=frontend /app/dist                                       /home/baseport/static

ENV BASEPORT_DATA_DIR=/home/baseport/data \
    BASEPORT_PORT=8473
EXPOSE 8473

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD curl -fsS http://localhost:8473/api/health || exit 1

CMD ["baseport-server"]
