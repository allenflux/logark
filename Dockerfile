FROM rust:1.95-slim AS builder
WORKDIR /app
ENV CARGO_BUILD_JOBS=1
COPY . .
RUN apt-get update && apt-get install -y pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cargo build --release --bins

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/logark-server /usr/local/bin/logark-server
COPY --from=builder /app/target/release/logark-tg-bot /usr/local/bin/logark-tg-bot
COPY --from=builder /app/static /app/static
EXPOSE 7700
CMD ["logark-server"]
