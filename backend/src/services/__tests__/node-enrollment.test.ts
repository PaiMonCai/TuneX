import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNodeInstallScript } from "../node-enrollment.ts";

describe("node enrollment Docker installer", () => {
  test("deploys each Agent as an isolated host-network Docker instance", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain('CONTAINER="tunex-agent-$AGENT_ID"');
    expect(script).toContain('INSTANCE_ENV_DIR="/etc/tunex-agent/instances/$AGENT_ID"');
    expect(script).toContain('INSTANCE_STATE_DIR="/var/lib/tunex-agent/instances/$AGENT_ID"');
    expect(script).toContain('--name "$CONTAINER"');
    expect(script).toContain("--network host");
    expect(script).toContain("--restart unless-stopped");
    expect(script).toContain("--cap-drop ALL");
    expect(script).toContain("--cap-add NET_BIND_SERVICE");
    expect(script).toContain('-v "$ENV_FILE:/run/tunex-agent/agent.env:ro"');
    expect(script).toContain('-v "$INSTANCE_STATE_DIR:/var/lib/tunex-agent"');
    expect(script).toContain('--label "io.tunex.agent=true"');
    expect(script).toContain('--label "io.tunex.agent-id=$AGENT_ID"');
  });

  test("reinstall removes only the current instance, never a sibling Agent", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain('docker rm -f "$CONTAINER"');
    expect(script).not.toContain("docker rm -f tunex-agent >/dev/null");
    // Legacy global container is touched only after the env proves it is this agent.
    const legacySelf = script.indexOf('if [ "$LEGACY_SELF" -eq 1 ]');
    const legacyRemove = script.indexOf('docker rm -f "$LEGACY_CONTAINER"', legacySelf);
    expect(legacySelf).toBeGreaterThan(-1);
    expect(legacyRemove).toBeGreaterThan(legacySelf);
  });

  test("checks sibling port ranges before consuming the one-time enrollment token", () => {
    const script = renderNodeInstallScript();
    const enumerate = script.indexOf('docker ps -a --filter "label=io.tunex.agent=true"');
    const overlap = script.indexOf("ranges_overlap");
    const enroll = script.indexOf("/api/internal/node/enroll");

    expect(enumerate).toBeGreaterThan(-1);
    expect(overlap).toBeGreaterThan(-1);
    expect(enroll).toBeGreaterThan(enumerate);
    expect(enroll).toBeGreaterThan(overlap);
    expect(script).toContain("port range $WANT overlaps existing TuneX Agent");
  });

  test("recognises the old single-instance layout without trusting the container name alone", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain('LEGACY_ENV_FILE="/etc/tunex-agent/agent.env"');
    expect(script).toContain('LEGACY_AGENT_ID="$(read_env_value TUNEX_AGENT_ID "$LEGACY_ENV_FILE")"');
    expect(script).toContain('if [ "$LEGACY_AGENT_ID" = "$AGENT_ID" ]');
    expect(script).not.toContain('. "$LEGACY_ENV_FILE"');
    expect(script).not.toContain("source $LEGACY_ENV_FILE");
  });

  test("migrates only the durable LKG/fence files for the same legacy agent", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain("for STATE_FILE in desired-lkg.json ownership-epoch.json");
    expect(script).toContain('cp -p "$LEGACY_STATE_DIR/$STATE_FILE" "$INSTANCE_STATE_DIR/$STATE_FILE"');
    expect(script).not.toContain('cp -a "$LEGACY_STATE_DIR');
  });

  test("does not inject the long-lived credential into Docker metadata", () => {
    const script = renderNodeInstallScript();

    expect(script).toContain('chmod 0600 "$ENV_FILE"');
    expect(script).not.toContain("--env-file");
    expect(script).not.toContain("-e TUNEX_NODE_CREDENTIAL");
    expect(script).not.toContain("/api/internal/node/binary/");
  });

  test("pulls and validates host conflicts before consuming the one-time enrollment token", () => {
    const script = renderNodeInstallScript();
    const conflictScan = script.indexOf('docker ps -a --filter "label=io.tunex.agent=true"');
    const pull = script.indexOf('docker pull "$AGENT_IMAGE"');
    const enroll = script.indexOf("/api/internal/node/enroll");

    expect(conflictScan).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(conflictScan);
    expect(enroll).toBeGreaterThan(pull);
  });

  test("rendered installer is valid POSIX shell", () => {
    const script = renderNodeInstallScript();
    const dir = mkdtempSync(join(tmpdir(), "tunex-enroll-syntax-"));
    const file = join(dir, "install.sh");
    writeFileSync(file, script, { mode: 0o700 });
    try {
      const proc = Bun.spawnSync(["sh", "-n", file], { stdout: "pipe", stderr: "pipe" });
      const stderr = new TextDecoder().decode(proc.stderr);
      expect(`sh rc=${proc.exitCode} ${stderr.trim()}`).toBe("sh rc=0 ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
