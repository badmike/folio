# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /app folio && mkdir -p /app/data && chown -R folio /app
WORKDIR /app
COPY --from=build /src/target/release/folio-server /usr/local/bin/folio-server
USER folio
ENV FOLIO_BIND=0.0.0.0:8989 DATABASE_URL=sqlite://data/folio.db
VOLUME ["/app/data"]
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/folio-server", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/folio-server"]
