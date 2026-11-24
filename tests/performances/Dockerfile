FROM oven/bun:1.4.4-debian
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
VOLUME ["/tmp"]
CMD ["sleep", "infinity"]
