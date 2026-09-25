import { describe, expect, test } from "bun:test";
import { renderNodeInstallScript } from "../node-enrollment.ts";

describe("node enrollment Docker installer", () => {
  test("deploys Agent as a host-network Docker container", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain('docker pull "$AGENT_IMAGE"');
    expect(script).toContain("--network host");
    expect(script).toContain("--restart unless-stopped");
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("--cap-add NET_BIND_SERVICE");
    expect(script).toContain(
      "-v /etc/tunex-agent/agent.env:/run/tunex-agent/agent.env:ro",
    );
  });

  test("does not inject the long-lived credential into Docker metadata", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain("chmod 0600 /etc/tunex-agent/agent.env");
    expect(script).not.toContain("--env-file");
    expect(script).not.toContain("-e TUNEX_NODE_CREDENTIAL");
    expect(script).not.toContain("/api/internal/node/binary/");
  });

  test("pulls the image before consuming the one-time enrollment token", () => {
    const script = renderNodeInstallScript();
    const pull = script.indexOf('docker pull "$AGENT_IMAGE"');
    const enroll = script.indexOf("/api/internal/node/enroll");

    expect(pull).toBeGreaterThanOrEqual(0);
    expect(enroll).toBeGreaterThan(pull);
  });
});
