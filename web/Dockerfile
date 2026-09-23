# syntax=docker/dockerfile:1
# ============================================================================
# RelayX web —— Next.js 生产镜像（多阶段构建）
#
# 阶段：
#   deps    → 安装依赖（npm ci，利用 package-lock.json 锁定版本）
#   builder → 编译 Next.js（npm run build，产出 .next）
#   runner  → 仅携带运行所需产物（.next / public / node_modules / 配置）
#
# 运行：npm start → next start -p 3000（见 package.json）
# 监听端口：3000（仅容器内，由 Caddy 反向代理 web:3000 访问，不映射到主机）
# ============================================================================

# ---------------------------------------------------------------------------
# 阶段 1：deps —— 安装依赖
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# npm ci 需要 package.json + package-lock.json 一起复制
COPY package.json package-lock.json ./

# 使用 npmmirror 源（.npmrc）加速；npm ci 严格按 lockfile 安装，可复现
RUN npm ci

# ---------------------------------------------------------------------------
# 阶段 2：builder —— 编译 Next.js
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# 复用 deps 阶段已安装的 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制构建所需源码与配置
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY next.config.ts ./
COPY postcss.config.mjs ./
COPY next-env.d.ts ./
COPY src ./src
# public 为可选静态资源目录；镜像中已随源码提供（含占位文件保证 COPY 成功）
COPY public ./public

# Next 会在 build 时把 NEXT_PUBLIC_* 内联进产物。
# 生产环境前端与服务同一站点（Caddy 路由 /api/* → backend），故 API 基址留空
# 走同源相对路径；显式关闭 mock。构建期 env 优先级高于 .env* 文件。
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_BASE=
ENV NEXT_PUBLIC_API_MOCK=0

RUN npm run build

# ---------------------------------------------------------------------------
# 阶段 3：runner —— 仅保留运行时产物
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 运行 `next start` 所需的最小文件集：
# 编译产物 + 静态资源 + 运行时依赖 + 项目清单/配置
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/next-env.d.ts ./next-env.d.ts

EXPOSE 3000

# package.json: "start": "next start -p 3000"
CMD ["npm", "start"]
