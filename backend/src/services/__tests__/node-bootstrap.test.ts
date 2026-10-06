import { describe, expect, test } from "bun:test";
import { NODE_BOOTSTRAP_DOCKER_VERSION, renderNodeInstallScript } from "../node-enrollment.ts";

describe("node bootstrap Docker contract", () => {
  test("uses an explicit semantic Docker version", () => {
    expect(NODE_BOOTSTRAP_DOCKER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("rendered installer pins Docker and fails instead of falling back to latest", () => {
    const script = renderNodeInstallScript();
    expect(script).toContain(`DOCKER_PIN="${NODE_BOOTSTRAP_DOCKER_VERSION}"`);
    expect(script).toContain('sh "$TMP_DOCKER" --version "$DOCKER_PIN"');
    expect(script).not.toContain('sh "$TMP_DOCKER"\n');
    expect(script).toContain("exit 4");
  });

  test("does not consume enrollment before the agent image is available", () => {
    const script = renderNodeInstallScript();
    expect(script.indexOf('docker pull "$AGENT_IMAGE"')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('docker pull "$AGENT_IMAGE"')).toBeLessThan(
      script.indexOf('"$PANEL/api/internal/node/enroll"'),
    );
  });
});
