# Build tools are only needed to compile optional native addons (e.g. secp256k1);
# they're not present in the final image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN useradd --uid 1001 --user-group --create-home appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app
USER appuser

# faucet.db and account_creations live here; mount a volume at /app/data to persist them
VOLUME ["/app/data"]

CMD ["node", "index.js"]
