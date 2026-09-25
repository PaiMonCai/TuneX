import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    // 后端未就绪时的兜底：API_MOCK=1 时前端走 src/mocks，不触发 rewrite。
    const mock = process.env.NEXT_PUBLIC_API_MOCK === "1";
    if (mock) return [];

    // 生产环境（容器/Caddy）中前端与后端同源：
    // Caddy 已把 /api/* 直接路由到 backend:3000，Next 无需再代理。
    // 此时 NEXT_PUBLIC_API_BASE 留空，显式返回 []，避免 /api/* → 自身造成 rewrite 环路
    // （若指向 127.0.0.1:8080 而 Caddy 恰好占用 8080，会把 /api/* 打回 Caddy 形成死循环）。
    const base = process.env.NEXT_PUBLIC_API_BASE;
    if (!base) return [];

    return [
      {
        source: "/api/:path*",
        destination: `${base}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
