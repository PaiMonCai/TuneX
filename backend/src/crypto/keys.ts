/**
 * TuneX Fernet keys.
 *
 * Each installation generates its own config key and license key. There is no
 * built-in default: if the environment variables are missing the backend
 * refuses to start, so a key leaked from one deployment can never be used to
 * forge configs or licenses against another.
 */

/** Validate a 32-byte base64url Fernet key supplied by the deployment. */
function requiredKey(name: "TUNEX_CONFIG_KEY" | "TUNEX_LICENSE_KEY"): string {
  const key = process.env[name]?.trim();
  if (!key || !/^[A-Za-z0-9_-]{43}=?$/.test(key) || Buffer.from(key, "base64url").length !== 32) {
    throw new Error(`${name} must be a unique, 32-byte base64url Fernet key`);
  }
  return key;
}

/**
 * Data-plane auth HKDF info constant.
 *
 * This is a protocol label (not a secret) that participates in the data-plane
 * tunnel token derivation: HKDF-SHA256(authKey, salt=nil, info="tunex-auth-v1",
 * L=32), used by nodes whose tunnel type is `tunex`.
 */
export const TUNEX_AUTH_HKDF_INFO = 'tunex-auth-v1';

/** Data-plane token time window, in seconds. */
export const TUNEX_AUTH_WINDOW_SECONDS = 300;

/** Data-plane token length: nonce(16) + UnixNano(8) + HMAC-SHA256(32) = 56 bytes. */
export const TUNEX_AUTH_TOKEN_BYTES = 56;

/** Field offsets in the 56-byte token. */
export const TUNEX_AUTH_TOKEN_OFFSETS = {
  nonce: 0,
  timestamp: 16,
  mac: 24,
  total: 56,
} as const;

/** Key shared only between this installation's backend and its own agents. */
export function configKey(): string {
  return requiredKey("TUNEX_CONFIG_KEY");
}

/** A second, independent key for the node registration response. */
export function licenseKey(): string {
  return requiredKey("TUNEX_LICENSE_KEY");
}
