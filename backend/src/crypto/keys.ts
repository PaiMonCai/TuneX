/**
 * TuneX data-plane auth constants (protocol labels, not secrets).
 *
 * The per-install Fernet keys (`configKey` / `licenseKey`) were removed in
 * WP15 together with the legacy agent's config push and license signing:
 * they existed only to authenticate the Socket.IO/Fernet channel that carried
 * the old gost config. The v3 control plane authenticates per-node
 * credentials instead, so refusing to boot on a missing `TUNEX_CONFIG_KEY`
 * would break deployments that have no legacy agent to serve.
 */

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
