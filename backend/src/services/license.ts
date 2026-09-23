import { redis, RedisKeys } from "../redis.ts";
import { env } from "../env.ts";

export type LicenseType = "personal" | "business";

export interface LicenseInfo {
  type: LicenseType;
  expired_at: number;
  site_url?: string;
}

/**
 * License 服务
 * 原版从远程 LICENSE_URL 拉取并缓存 Redis；本实现用 env + Redis 覆盖模拟，
 * 保留 getLicense / isBusinessLicense / businessLicenseRequired 的语义。
 */
class LicenseService {
  async getLicense(): Promise<LicenseInfo | null> {
    try {
      const cached = await redis.get(RedisKeys.license);
      if (cached) return JSON.parse(cached) as LicenseInfo;
    } catch {
      /* Redis 不可用时回落到 env */
    }

    if (env.licenseType === "none") return null;

    const license: LicenseInfo = {
      type: (env.licenseType as LicenseType) ?? "business",
      expired_at: env.licenseExpiredAt,
      site_url: env.siteUrl,
    };
    try {
      await redis.set(RedisKeys.license, JSON.stringify(license));
    } catch {
      /* 忽略缓存写失败 */
    }
    return license;
  }

  /**
   * 原版语义：无 license 视为 business（放行），个人授权视为非商业。
   * 注意与 businessLicenseRequired 的判定方向相反。
   */
  async isBusinessLicense(): Promise<boolean> {
    const license = await this.getLicense();
    return !license || license.type === "business";
  }
}

export const licenseService = new LicenseService();
