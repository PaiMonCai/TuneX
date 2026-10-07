import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../auth-form.tsx", import.meta.url)),
  "utf8",
);

describe("A00 auth form no-JS safety", () => {
  test("credentials are not submitted with the browser default GET before hydration", () => {
    expect(source).toContain('<form method="post" onSubmit={onSubmit}');
    expect(source).toContain('name="email"');
    expect(source).toContain('name="password"');
  });
});
