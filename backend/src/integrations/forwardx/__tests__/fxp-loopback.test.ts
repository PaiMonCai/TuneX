import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import dgram from "node:dgram";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFxpLink } from "../link-compiler.ts";

const binary = process.env.TUNEX_TEST_FXP_BINARY;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function tcpTarget() {
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket); socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {}); socket.on("data", (data) => socket.write(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { for (const client of clients) client.destroy(); await new Promise<void>((r) => server.close(() => r())); });
  return (server.address() as net.AddressInfo).port;
}
async function udpTarget(port: number) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, source) => socket.send(message, source.port, source.address));
  await new Promise<void>((resolve) => socket.bind(port, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => socket.close(resolve)));
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function start(config: unknown): Promise<ChildProcess> {
  const dir = await mkdtemp(join(tmpdir(), "tunex-fxp-loopback-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.json"); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const process = spawn(binary!, ["-config", path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const collect = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-16_384); };
  process.stdout!.on("data", collect); process.stderr!.on("data", collect);
  cleanup.push(async () => {
    if (process.exitCode != null) return;
    const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
    process.kill(); await exited;
  });
  for (let i = 0; i < 100; i++) {
    if (logs.includes("tcp listening") && logs.includes("udp listening")) return process;
    if (process.exitCode != null) throw new Error("fxp_process_exited_before_listening");
    await delay(30);
  }
  throw new Error("fxp_listen_timeout");
}
function tcpEcho(port: number, payload: string, hold = false): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1"); let received = "";
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("payload_timeout")); });
    socket.on("error", reject); socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { received += chunk.toString();
      if (received === payload) { socket.setTimeout(0); if (!hold) socket.end(); resolve(socket); }
    });
  });
}
function udpEcho(port: number, payload: string, timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve(null); }, timeout);
    socket.once("message", (message) => { clearTimeout(timer); socket.close(); resolve(message.toString()); });
    socket.once("error", () => { clearTimeout(timer); socket.close(); resolve(null); });
    socket.send(Buffer.from(payload), port, "127.0.0.1");
  });
}

// CI must build the pinned executable before this gate. An absent executable is
// an explicit skip, never evidence that the transport works.
(binary ? test : test.skip)("compiled shared FXP runs encrypted TCP/UDP on one port and shares admission across both lanes", async () => {
  const target = await tcpTarget(); await udpTarget(target);
  const carrier = await freePort(), listen = await freePort(), other = await freePort();
  const node = { workspace_id: 3, connect_host: "127.0.0.1", version: "0.0.0-dev", capabilities: ["forward.link.fxp.v1"] };
  const compiled = compileFxpLink({ link_id: 7, workspace_id: 3, version: 1, generation: 1,
    ingress: { ...node, id: 11 }, egress: { ...node, id: 12 }, carrier_port: carrier,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), bindings: [
      { forward_id: 21, protocol: "both", listen_host: "127.0.0.1", listen_port: listen,
        target_host: "127.0.0.1", target_port: target, max_connections: 1, max_connections_per_ip: 1 },
      { forward_id: 22, protocol: "both", listen_host: "127.0.0.1", listen_port: other,
        target_host: "127.0.0.1", target_port: target },
    ] }, "51".repeat(32));
  await start(compiled.egress.runner_config); await start(compiled.ingress.runner_config);
  const held = await tcpEcho(listen, "encrypted-tcp-A", true);
  cleanup.push(async () => held.destroy());
  expect(await udpEcho(listen, "must-not-get-a-second-budget", 200)).toBeNull();
  expect(await udpEcho(other, "independent-B", 1500)).toBe("independent-B");
  await tcpEcho(other, "encrypted-tcp-B");
  held.end(); await delay(80);
  expect(await udpEcho(listen, "encrypted-udp-A", 1500)).toBe("encrypted-udp-A");
}, 15_000);
