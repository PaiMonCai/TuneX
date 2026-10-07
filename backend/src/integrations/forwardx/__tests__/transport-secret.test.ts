import { expect, test } from "bun:test";
import { sealLinkTransportKey, unsealLinkTransportKey, newLinkTransportKey } from "../transport-secret.ts";

test("transport credentials bind workspace/link/generation and require independent seal material", () => {
  const secret = newLinkTransportKey(), installationKey = "52".repeat(32);
  const sealed = sealLinkTransportKey(secret, installationKey, 1, 2, 3);
  expect(sealed).not.toContain(secret);
  expect(unsealLinkTransportKey(sealed, installationKey, 1, 2, 3)).toBe(secret);
  for (const ids of [[9, 2, 3], [1, 9, 3], [1, 2, 9]])
    expect(() => unsealLinkTransportKey(sealed, installationKey, ids[0]!, ids[1]!, ids[2]!)).toThrow();
  expect(() => unsealLinkTransportKey(sealed, "53".repeat(32), 1, 2, 3)).toThrow();
  expect(() => sealLinkTransportKey(secret, "auth-secret-is-not-a-seal-key", 1, 2, 3)).toThrow();
  expect(sealLinkTransportKey(secret, installationKey, 1, 2, 3)).not.toBe(sealed);
});
