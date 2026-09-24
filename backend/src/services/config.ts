import { db } from "../db.ts";
import { env } from "../env.ts";
import type { SystemConfigName } from "@prisma/client";

/**
 * 系统配置读取（config 表，34 项）
 * 原版无缓存层（每次读 DB）；本实现加 5s 短缓存降低 DB 压力，语义保持一致。
 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: string | null; at: number }>();

export class SystemConfigService {
  async getConfig(name: SystemConfigName | string): Promise<string | null> {
    const key = String(name);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    try {
      const row = await db.systemConfig.findUnique({ where: { name: key as SystemConfigName } });
      const value = row?.value ?? null;
      cache.set(key, { value, at: Date.now() });
      return value;
    } catch {
      // DB 不可用时不缓存失败结果
      return null;
    }
  }

  async getBool(name: SystemConfigName | string, fallback = false): Promise<boolean> {
    const v = await this.getConfig(name);
    if (v === null) return fallback;
    return v === "true" || v === "1";
  }

  async getNumber(name: SystemConfigName | string, fallback = 0): Promise<number> {
    const v = await this.getConfig(name);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  async setConfig(name: SystemConfigName | string, value: string): Promise<void> {
    await db.systemConfig.upsert({
      where: { name: name as SystemConfigName },
      create: { name: name as SystemConfigName, value },
      update: { value },
    });
    cache.delete(String(name));
  }

  async listAll() {
    return db.systemConfig.findMany({ orderBy: { name: "asc" } });
  }

  /** ALLOW_REGISTER：以 config 表为准，缺失时用 env 兜底 */
  async allowRegister(): Promise<boolean> {
    return this.getBool("ALLOW_REGISTER", env.allowRegisterFallback);
  }
}

export const systemConfig = new SystemConfigService();
