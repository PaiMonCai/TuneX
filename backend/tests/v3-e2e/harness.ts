/**
 * WP14 v3 E2E Harness —— shared harness utilities
 *
 * Why this file exists
 * ---------------------------------------------------------------
 * DEVELOPMENT.md §7.15 (WP14) requires a real-network E2E topology:
 *   Control Plane / Ingress Agent / Egress Agent / Target A / Target B
 *   + at least one agent behind NAT (outbound only).
 *
 * Current reality: the functional work packages (WP5 relay dataplane,
 * WP8 orchestrator, WP9 reconciler, ...) are NOT merged yet. This harness
 * therefore has to satisfy two contradictory constraints at once:
 *
 *   1. It must be runnable / reviewable today, before those WPs exist.
 *   2. It must NEVER report a feature as "passing" just because the
 *      feature is not implemented yet.
 *
 * The resolution: every helper in this module either drives a REAL
 * process (docker compose service, control-plane HTTP API, Socket.IO
 * connection) or reports an explicit `unavailable` status. Nothing here
 * fakes a data-plane response.
 *
 * Reading the results
 * ---------------------------------------------------------------
 * `assertMarker()` and friends never throw "successfully". They return
 * an {@link AssertionResult} whose `status` is one of:
 *
 *   · "pass"        — the observable behaviour matched the expectation
 *   · "fail"        — the observable behaviour contradicted it
 *                     (this is a real defect / regression)
 *   · "unavailable" — the environment could not answer the question
 *                     (service down, port not listening, agent not
 *                     connected). Reported as its own bucket so a
 *                     missing feature can never be laundered into
 *                     "pass" by silence.
 *
 * The runner (`node:test`) prints all three buckets; a WP14 gate run
 * must see `unavailable = 0` before it may claim relay works.
 *
 * See scripts/v3-e2e/README.md for the topology and the full status
 * of each formal gate item.
 */
import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/**
 * Path anchors, all derived from this file so the harness works in any
 * worktree / CI checkout (never hardcode "/opt/TuneX" — see the tunex
 * backend workflow skill's ROOT rule).
 *
 *   this file       <repo>/backend/tests/v3-e2e/harness.ts
 *   HARNESS_DIR     <repo>/backend/tests/v3-e2e
 *   BACKEND_TESTS   <repo>/backend/tests
 *   REPO_ROOT       <repo>
 */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_TESTS = resolve(HARNESS_DIR, "..");
const REPO_ROOT = resolve(BACKEND_TESTS, "../..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts", "v3-e2e");

export { HARNESS_DIR, BACKEND_TESTS, REPO_ROOT, SCRIPTS_DIR };
export const COMPOSE_FILE = join(SCRIPTS_DIR, "docker-compose.e2e.yaml");
export const STATE_FILE = join(SCRIPTS_DIR, "state.json");
export const ARTIFACT_DIR = join(HARNESS_DIR, ".artifacts");
export const CONTAINERS = {
  panel: "wp14-panel",
  ingressAgent: "wp14-ingress-agent",
  egressAgent: "wp14-egress-agent",
  targetA: "wp14-target-a",
  targetB: "wp14-target-b",
} as const;

export const MARKERS = {
  targetA: "WP14-TARGET-A",
  targetB: "WP14-TARGET-B",
} as const;

/** Default host-side ports (overridable so CI can avoid collisions). */
export const HOST_PORTS = {
  panelHttp: Number(process.env.WP14_PANEL_HTTP_PORT ?? 18180),
  panelSocket: Number(process.env.WP14_PANEL_SOCKET_PORT ?? 18181),
  ingressDirect: Number(process.env.WP14_INGRESS_PORT_DIRECT ?? 18201),
  ingressRelay: Number(process.env.WP14_INGRESS_PORT_RELAY ?? 18202),
} as const;

/* ================================================================== */
/* Status model                                                        */
/* ================================================================== */

export type AssertionStatus = "pass" | "fail" | "unavailable";

export interface AssertionResult {
  status: AssertionStatus;
  label: string;
  /** Human-readable evidence (probe output, exception message, ...). */
  detail?: string;
}

function pass(label: string, detail?: string): AssertionResult {
  return { status: "pass", label, detail };
}
function fail(label: string, detail?: string): AssertionResult {
  return { status: "fail", label, detail };
}
function unavailable(label: string, detail?: string): AssertionResult {
  return { status: "unavailable", label, detail };
}

/** Aggregate a list of results into three counters + a short human summary. */
export function summarize(results: AssertionResult[]): {
  pass: number;
  fail: number;
  unavailable: number;
  summary: string;
} {
  const p = results.filter((r) => r.status === "pass").length;
  const f = results.filter((r) => r.status === "fail").length;
  const u = results.filter((r) => r.status === "unavailable").length;
  const summary = results
    .map((r) => `  [${r.status.toUpperCase().padEnd(11)}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`)
    .join("\n");
  return { pass: p, fail: f, unavailable: u, summary };
}

/**
 * Throw only for *real* failures. `unavailable` is surfaced as a skipped
 * reason so the test run cannot silently claim success while the
 * environment is absent — `node:test` reports the skip in its output.
 */
export function assertNoFailures(results: AssertionResult[], context: string): void {
  const { fail: f, unavailable: u, summary } = summarize(results);
  if (f > 0) {
    throw new Error(
      `${context}: ${f} FAILED assertion(s)` +
        (u > 0 ? ` (+${u} unavailable, need a real environment)` : "") +
        `\n${summary}`,
    );
  }
  if (u > 0) {
    // Deliberately NOT a failure: the harness is honest that it could not
    // observe anything. scripts/v3-e2e/README.md documents this contract.
    console.warn(
      `[wp14-harness] ${context}: ${u} assertion(s) unavailable ` +
        `(environment incomplete — nothing was verified)`,
    );
  }
}

/* ================================================================== */
/* Process / container helpers                                         */
/* ================================================================== */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a shell-free command (no intermediate shell, so quotes are exact). */
export async function run(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e: unknown) {
    const err = e as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    // Node's child_process rejects with a string `code` ("ENOENT") for a
    // missing binary and a numeric `code` (exit status) otherwise. Timeouts
    // set `killed` instead. Normalize all three into the numeric contract
    // below so callers never have to special-case the error shape.
    const numeric = typeof err.code === "number" ? err.code : null;
    let code = numeric;
    if (code === null && err.code === "ENOENT") code = 127;
    if (code === null && (err.killed || err.signal === "SIGTERM")) code = 124;
    if (code === null) code = -1;
    let stderr = err.stderr ?? "";
    if (!stderr && err.message) stderr = err.message;
    if (err.killed) stderr = `timeout after ${timeoutMs}ms: ${stderr}`.trim();
    return { code, stdout: err.stdout ?? "", stderr };
  }
}

/** `docker compose -f <compose> ...` in the repo root. */
export function compose(args: string[]): Promise<ExecResult> {
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...args], { cwd: REPO_ROOT });
}

/** True when the container exists and is running. */
export async function isContainerRunning(name: string): Promise<boolean> {
  const r = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Container's host port bindings as `{ "container/proto": hostPort }`. */
export async function portBindings(name: string): Promise<Record<string, string>> {
  const r = await run("docker", ["inspect", "-f", "{{json .HostConfig.PortBindings}}", name]);
  if (r.code !== 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim() || "{}");
  } catch {
    return {};
  }
  const bindings = ((parsed ?? {}) as Record<string, Array<{ HostPort?: string }> | null>);
  const out: Record<string, string> = {};
  for (const [key, list] of Object.entries(bindings)) {
    const first = Array.isArray(list) ? list[0]?.HostPort : undefined;
    if (first) out[key] = first;
  }
  return out;
}

/** Docker networks the container is attached to. */
export async function containerNetworks(name: string): Promise<string[]> {
  const r = await run("docker", [
    "inspect",
    "-f",
    "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
    name,
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split(/\s+/).filter(Boolean);
}

/** Read a container's logs (stdout+stderr). */
export async function containerLogs(name: string, tail = 500): Promise<string> {
  const r = await run("docker", ["logs", `--tail=${tail}`, name]);
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

/** Spawn a repo script detached-ish; the caller owns the child process. */
export function spawnScript(scriptPath: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawn("bash", [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/* ================================================================== */
/* Assertions                                                          */
/* ================================================================== */

export interface ReachOptions {
  host?: string;
  port: number;
  /** ms to wait for the TCP connect. Default 4000. */
  timeoutMs?: number;
  /** ms to wait for the first byte. Default 4000. */
  readTimeoutMs?: number;
  /** Bytes to send before reading (marker targets are echo servers). */
  send?: string;
}

export interface ReachEvidence {
  connected: boolean;
  response: string;
  latencyMs?: number;
  error?: string;
}

/**
 * Open a real TCP connection and read one reply. This is the only
 * data-plane observation the harness makes — no fakes, no fixtures
 * standing in for the tunnel.
 */
export async function probeTcp(options: ReachOptions): Promise<ReachEvidence> {
  const {
    host = "127.0.0.1",
    port,
    timeoutMs = 4_000,
    readTimeoutMs = 4_000,
    send,
  } = options;
  const started = Date.now();
  return new Promise<ReachEvidence>((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (evidence: ReachEvidence) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(evidence);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", (err: Error) => {
      finish({ connected: false, response: "", error: err.message });
    });
    socket.once("timeout", () => {
      finish({ connected: false, response: "", error: `connect timeout after ${timeoutMs}ms` });
    });
    socket.once("connect", () => {
      if (send) socket.write(send);
      socket.setTimeout(readTimeoutMs);
    });
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      finish({
        connected: true,
        response: buffer.trim(),
        latencyMs: Date.now() - started,
      });
    });
  });
}

/**
 * Assert that a TCP endpoint answers with the expected marker.
 *
 * `unavailable` (never `fail`) when nothing is listening: a hub with no
 * service says nothing about whether the dataplane is correct.
 */
export async function assertMarker(
  label: string,
  options: ReachOptions & { expected: string },
): Promise<AssertionResult> {
  const evidence = await probeTcp(options);
  if (!evidence.connected) {
    return unavailable(`${label} — nothing listening`, evidence.error);
  }
  if (evidence.response === options.expected) {
    return pass(label, `response="${evidence.response}"`);
  }
  if (evidence.response === "") {
    return fail(label, "connected but received no reply");
  }
  return fail(label, `expected "${options.expected}", got "${evidence.response}"`);
}

/** Assert a marker is NOT returned by an endpoint (data-plane isolation). */
export async function assertNotMarker(
  label: string,
  options: ReachOptions & { unexpected: string },
): Promise<AssertionResult> {
  const evidence = await probeTcp(options);
  if (!evidence.connected) {
    return unavailable(`${label} — nothing listening`, evidence.error);
  }
  if (evidence.response === options.unexpected) {
    return fail(label, `endpoint leaked "${options.unexpected}"`);
  }
  return pass(label, `response="${evidence.response}"`);
}

/* ================================================================== */
/* Control-plane HTTP client                                           */
/* ================================================================== */

export interface HttpRequest {
  method: string;
  path: string;
  cookie?: string;
  workspaceId?: number | string;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  json: unknown;
  raw: string;
  setCookie: string | null;
}

const COOKIE_HEADER = "cookie";

/** Minimal control-plane client (no external deps; fetch is built in). */
export async function controlPlane(
  request: HttpRequest,
  baseUrl = `http://127.0.0.1:${HOST_PORTS.panelHttp}`,
): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  if (request.cookie) headers[COOKIE_HEADER] = request.cookie;
  if (request.workspaceId !== undefined) headers["x-workspace-id"] = String(request.workspaceId);
  let response: Response;
  try {
    response = await fetch(baseUrl + request.path, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: unknown) {
    return { status: 0, json: null, raw: String((e as Error).message ?? e), setCookie: null };
  }
  const raw = await response.text();
  const setCookie = response.headers.get("set-cookie");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, setCookie };
}

/** Log in as an existing WP14 fixture user and return the session cookie. */
export async function login(
  email: string,
  password: string,
  baseUrl?: string,
): Promise<HttpResponse> {
  return controlPlane({ method: "POST", path: "/api/auth/login", body: { email, password } }, baseUrl);
}

/* ================================================================== */
/* Fixture state                                                       */
/* ================================================================== */

export interface Wp14State {
  api: string;
  siteUrl: string;
  user: { email: string; password: string };
  workspaces: Record<
    string,
    { id: number; name: string }
  >;
  nodeGroups: Record<
    string,
    {
      id: number;
      name: string;
      node_type: "in" | "out";
      token: string;
      workspace: string;
      port_range: string;
      node_id: string | null;
    }
  >;
  tunnels: Record<
    string,
    {
      id: number;
      name: string;
      workspace: string;
      listen_port: number;
      expected_marker: string;
    }
  >;
  markers: { target_a: string; target_b: string };
  hostPorts: { direct: number; relay: number };
}

export async function loadState(path = STATE_FILE): Promise<Wp14State> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Wp14State;
}

export async function stateExists(path = STATE_FILE): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== */
/* Log / metric collection                                             */
/* ================================================================== */

export interface CollectedLogs {
  [containerName: string]: string;
}

/** Collect the last N lines of every container in the topology. */
export async function collectLogs(tail = 400): Promise<CollectedLogs> {
  const out: CollectedLogs = {};
  for (const [role, name] of Object.entries(CONTAINERS)) {
    const logs = await containerLogs(name, tail);
    if (logs.trim()) out[role] = logs;
  }
  return out;
}

/**
 * Persist an evidence bundle under backend/tests/v3-e2e/.artifacts/.
 * Returns the files written so callers can reference them in summaries.
 */
export async function saveArtifacts(
  name: string,
  payload: { results: AssertionResult[]; logs?: CollectedLogs; extra?: Record<string, unknown> },
): Promise<string[]> {
  // NOTE: fs/promises.writeFile does NOT create parent directories, so the
  // target directory must be created explicitly before writing (a missing
  // mkdir surfaced as ENOENT on the first write during the WP14 build).
  await rm(ARTIFACT_DIR, { recursive: true, force: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ARTIFACT_DIR, `${stamp}-${name}`);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  const files: Array<[string, string]> = [
    [`${name}-results.json`, JSON.stringify(payload.results, null, 2)],
    [`${name}-results.txt`, summarize(payload.results).summary],
  ];
  for (const [role, logs] of Object.entries(payload.logs ?? {})) {
    files.push([`${role}.log`, logs]);
  }
  if (payload.extra) {
    files.push([`${name}-extra.json`, JSON.stringify(payload.extra, null, 2)]);
  }
  for (const [file, content] of files) {
    const path = join(dir, file);
    await writeFile(path, content, "utf8");
    written.push(path);
  }
  return written;
}

/** List previous evidence bundles (newest last). */
export async function listArtifacts(): Promise<string[]> {
  try {
    const entries = await readdir(ARTIFACT_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/* ================================================================== */
/* Environment guard                                                   */
/* ================================================================== */

export interface EnvironmentCheck {
  ready: boolean;
  missing: string[];
  checked: string[];
}

/**
 * A WP14 E2E run needs: docker, the compose file, a state.json (written
 * by scripts/v3-e2e/setup.sh) and a running panel. Missing pieces make
 * the run `unavailable`, never `pass`.
 */
export async function checkEnvironment(): Promise<EnvironmentCheck> {
  const missing: string[] = [];
  const checked: string[] = [];

  const docker = await run("docker", ["version"]);
  if (docker.code !== 0) missing.push("docker");
  checked.push("docker");

  const compose = await run("docker", ["compose", "version"]);
  if (compose.code !== 0) missing.push("docker compose plugin");
  checked.push("docker compose");

  if (!(await stateExists())) missing.push("scripts/v3-e2e/state.json (run setup.sh)");
  checked.push("state.json");

  if (!(await isContainerRunning(CONTAINERS.panel))) missing.push(`${CONTAINERS.panel} not running`);
  checked.push("panel");

  return { ready: missing.length === 0, missing, checked };
}

/** `before` hook shared by both E2E suites. */
export async function requireEnvironment(context: string): Promise<EnvironmentCheck> {
  const check = await checkEnvironment();
  if (!check.ready) {
    const reason = `missing: ${check.missing.join(", ")}`;
    console.warn(`[wp14-harness] ${context}: environment incomplete — ${reason}`);
  }
  return check;
}
