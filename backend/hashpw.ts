/**
 * Standalone helper: print a bcrypt hash for a password supplied on the CLI.
 *
 * Usage: bun hashpw.ts "<password>"
 * The password is intentionally required; no sample credential is embedded.
 */
import bcrypt from "bcryptjs";

const plain = process.argv[2];
if (!plain) {
  console.error('usage: bun hashpw.ts "<password>"');
  process.exit(1);
}
console.log(await bcrypt.hash(plain, 10));