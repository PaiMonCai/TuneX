FROM oven/bun:1-debian
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY prisma ./prisma
RUN bunx prisma generate
COPY tsconfig.json ./
COPY src ./src
# 结构性防护（L55）：镜像内以 `bun` 用户运行，而**宿主机上新建的源文件可能是 0600**
# （本专项已因此踩坑 4 次，最近一次是 `src/services/node-install.ts` 让面板**直接起不来**：
#  `EACCES reading "/app/src/services/node-install.ts"`）。在镜像里兜底放宽读权限，
# 让"主机文件模式"这件事**在结构上不可能**再把容器打挂 —— 不依赖任何人记得 chmod。
RUN chmod -R a+rX /app/src /app/prisma
ENV NODE_ENV=production
USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
