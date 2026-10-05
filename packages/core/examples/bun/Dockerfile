FROM oven/bun:1.1.30-alpine

ENV BUN_VERSION=1.1.30

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "index.ts"]
