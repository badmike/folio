# syntax=docker/dockerfile:1
# folio: the web app and folio-server in one image. The server serves the app at `/`
# and the API under `/api`. Build locally with `docker build -t folio .`

ARG FOLIO_VERSION=dev

FROM node:22-bookworm-slim AS web
ARG FOLIO_VERSION
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/document/package.json packages/document/
COPY packages/editor/package.json packages/editor/
COPY packages/persistence/package.json packages/persistence/
COPY packages/recognition/package.json packages/recognition/
COPY packages/renderer/package.json packages/renderer/
COPY packages/sync/package.json packages/sync/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
# Typechecking happens in CI; the image only needs the bundle.
RUN VITE_FOLIO_VERSION=${FOLIO_VERSION} pnpm --filter @folio/web exec vite build

FROM rust:1-bookworm AS server
ARG FOLIO_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/server/Cargo.toml apps/server/Cargo.lock ./
COPY apps/server/migrations ./migrations
COPY apps/server/src ./src
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
  --mount=type=cache,id=cargo-target,target=/src/target \
  FOLIO_VERSION=${FOLIO_VERSION} cargo build --release --locked \
  && cp target/release/folio-server /usr/local/bin/folio-server

FROM debian:bookworm-slim
ARG FOLIO_VERSION
LABEL org.opencontainers.image.title="folio" \
  org.opencontainers.image.description="Offline-first semantic infinite canvas notebook" \
  org.opencontainers.image.source="https://github.com/badmike/folio" \
  org.opencontainers.image.version="${FOLIO_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /app folio && mkdir -p /app/data && chown -R folio /app
WORKDIR /app
COPY --from=server /usr/local/bin/folio-server /usr/local/bin/folio-server
COPY --from=web /src/apps/web/dist /app/web
USER folio
ENV FOLIO_BIND=0.0.0.0:8989 DATABASE_URL=sqlite://data/folio.db FOLIO_WEB_DIR=/app/web
VOLUME ["/app/data"]
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/folio-server", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/folio-server"]
