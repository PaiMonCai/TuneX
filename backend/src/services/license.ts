import { env } from "../env.ts";

export type LicenseType = "personal" | "business";

export interface LicenseInfo {
  type: LicenseType;
  expired_at: number;
  site_url?: string;
}

/**
 * Instance-level license projection.
 *
 * TuneX no longer has the legacy remote-license verification path. LICENSE_TYPE,
 * LICENSE_EXPIRED_AT and SITE_URL are process configuration, so Redis must not
 * become a second source of truth: caching them across restarts/config changes can
 * expose stale admin state indefinitely.
 */
class LicenseService {
  async getLicense(): Promise<LicenseInfo | null> {
    if (env.licenseType === "none") return null;

    // Unknown values are configuration errors, not an implicit business grant.
    if (env.licenseType !== "personal" && env.licenseType !== "business") {
      return null;
    }

    return {
      type: env.licenseType,
      expired_at: Number.isFinite(env.licenseExpiredAt) ? env.licenseExpiredAt : 0,
      site_url: env.siteUrl,
    };
  }

  async hasBusinessLicense(now: Date = new Date()): Promise<boolean> {
    const license = await this.getLicense();
    if (license?.type !== "business") return false;
    // 0 means no expiry. Positive values are Unix seconds, matching the legacy contract.
    return license.expired_at <= 0 || license.expired_at > Math.floor(now.getTime() / 1000);
  }
}

export const licenseService = new LicenseService();
