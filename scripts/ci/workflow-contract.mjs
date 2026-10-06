#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const ci = read(".github/workflows/ci.yml");
const integration = read(".github/workflows/integration.yml");
const release = read(".github/workflows/release.yml");

const failures = [];
const requireText = (name, text, needle) => {
  if (!text.includes(needle)) failures.push(`${name}: missing ${JSON.stringify(needle)}`);
};
const forbidText = (name, text, needle) => {
  if (text.includes(needle)) failures.push(`${name}: forbidden ${JSON.stringify(needle)}`);
};

// Source CI: current code quality + current persistence/upgrade behavior.
for (const needle of [
  "bun ci",
  "bunx prisma migrate deploy",
  "bunx prisma generate",
  "bunx tsc --noEmit",
  "bun run test:unit",
  "bun run test:integration",
  "Migrate and verify existing two-user database",
]) requireText("CI/backend", ci, needle);

// Historical v3 milestone coverage is no longer an automatic merge gate.
forbidText("CI/backend", ci, "Legacy backfill - existing DB upgrades to v3 without breaking DIRECT");

for (const needle of [
  "go vet ./...",
  "go test ./...",
  "go test -race ./internal/forwarder ./internal/control",
  "go build -buildvcs=false ./...",
]) requireText("CI/agent", ci, needle);

// Avoid executing the whole Agent suite twice and avoid release-build work in PR CI.
forbidText("CI/agent", ci, "go test -race ./...");
forbidText("CI/agent", ci, "GOOS=linux   GOARCH=amd64");
forbidText("CI/agent", ci, "GOOS=linux   GOARCH=arm64");

for (const needle of ["npm ci", "npm run typecheck", "npm run build"]) {
  requireText("CI/web", ci, needle);
}

requireText("CI/security", ci, "secret-scan.mjs");
requireText("CI/ops", ci, "installer-static.sh");
forbidText("CI/perf", ci, "test_v5_tcp_baseline.py");

// PR loop: create topology once and run exactly one current protocol regression.
// verify.sh/G0/G1A overlap with G1B and are deliberately not automatic here.
requireText("Integration/PR", integration, "if: github.event_name == 'pull_request'");
requireText("Integration/PR", integration, "bash scripts/v3-e2e/setup.sh");
requireText("Integration/PR", integration, "python3 scripts/v3-e2e/v5-g1b.py");
forbidText("Integration/PR", integration, "bash scripts/v3-e2e/verify.sh");

// Production invariant: build once, qualify exact digests, promote without rebuild.
requireText("Integration/candidate", integration, "candidate-images:");
requireText("Integration/candidate", integration, "candidate-${{ github.run_id }}");
requireText("Integration/candidate", integration, "steps.panel.outputs.digest");
requireText("Integration/candidate", integration, "steps.agent.outputs.digest");
requireText("Integration/qualification", integration, "release-qualification:");
requireText("Integration/qualification", integration, "needs: [candidate-images]");
requireText("Integration/qualification", integration, "needs.candidate-images.outputs.panel_digest");
requireText("Integration/qualification", integration, "needs.candidate-images.outputs.agent_digest");
requireText("Integration/qualification", integration, 'FED_SKIP_BUILD: "1"');

// Current release surfaces: protocol + multi-hop + federation.
for (const needle of [
  "scripts/v3-e2e/v5-g1b.py",
  "scripts/v3-e2e/v5-g4.py",
  "scripts/v3-e2e/bootstrap-federation.py",
  "scripts/v3-e2e/v5-g5.py",
]) requireText("Integration/current", integration, needle);

// Historical milestone gates are manual diagnostics only. Keep them out of every
// automatic PR/main run so coverage does not become duplicated release latency.
for (const needle of [
  "scripts/v3-e2e/v4-gate.sh",
  "scripts/v3-e2e/v4-gate-rest.sh",
  "scripts/v3-e2e/v4-gate-s10.sh",
  "scripts/v3-e2e/v4-gate-topology.sh",
  "scripts/v3-e2e/v4-gate-f2.py",
  "scripts/v3-e2e/v4-gate-f3.py",
  "scripts/v3-e2e/v4-gate-f4.py",
  "scripts/v3-e2e/v4-gate-f5.py",
  "scripts/v3-e2e/v5-g0.py",
  "scripts/v3-e2e/v5-g1a.py",
]) forbidText("Integration/history", integration, needle);

// Release promotes already-qualified immutable digests only.
forbidText("Release", release, "docker/build-push-action");
forbidText("Release", release, "docker build ");
requireText("Release", release, "candidate-${INTEGRATION_RUN_ID}");
requireText("Release", release, "Promote qualified digests without rebuilding");
requireText("Release", release, "Verify promoted tags are the qualified digests");
requireText("Release", release, "docker buildx imagetools create");

if (failures.length > 0) {
  console.error("Workflow contract failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Workflow contract OK");
