FROM oven/bun:1-debian
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN bun install
COPY prisma ./prisma
RUN bunx prisma generate
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/index.ts"]
