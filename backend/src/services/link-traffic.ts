import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.ts";
import { billingDayKeyStamp, billingPeriodKey } from "./billing-time.ts";

export const LINK_TRAFFIC_MAX_BODY_BYTES = 1_048_576;
export const LINK_TRAFFIC_MAX_SAMPLES = 2048;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const id = z.number().int().positive().max(2_147_483_647);
const isDecimal = (value: string) => /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= MAX_SAFE;
const decimal = z.string().refine(isDecimal, "counter_out_of_range");

/** Labels are Shanghai calendar days, not timestamps; use the existing archive stamp. */
export function linkTrafficDate(label: string): Date | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(label)) return null;
  // MySQL DATETIME supports years 1000..9999. Noon avoids historical timezone edges.
  if (Number(label.slice(0, 4)) < 1000) return null;
  const reference = new Date(`${label}T12:00:00.000Z`);
  if (!Number.isFinite(reference.getTime()) || reference.toISOString().slice(0, 10) !== label
    || billingPeriodKey(reference, "day") !== label) return null;
  return billingDayKeyStamp(reference);
}

export const LinkTrafficSampleSchema = z.object({
  producer_id: z.string().regex(/^[0-9a-f]{32}$/),
  link_id: id,
  workspace_id: id,
  node_id: id,
  forward_id: id,
  generation: id,
  config_digest: z.string().regex(/^[0-9a-fA-F]{64}$/),
  date: z.string().refine((value) => linkTrafficDate(value) !== null, "invalid_billing_date"),
  bytes_in: decimal,
  bytes_out: decimal,
  connections: decimal,
}).strict().refine((sample) => isDecimal(sample.bytes_in) && isDecimal(sample.bytes_out)
  && BigInt(sample.bytes_in) + BigInt(sample.bytes_out) <= MAX_SAFE,
  "combined_bytes_out_of_range");

export const LinkTrafficBatchSchema = z.object({
  samples: z.array(LinkTrafficSampleSchema).max(LINK_TRAFFIC_MAX_SAMPLES),
}).strict();
export type LinkTrafficSample = z.infer<typeof LinkTrafficSampleSchema>;
export type LinkTrafficTotals = { bytes_in: bigint; bytes_out: bigint; connections: bigint };
export type LinkTrafficCheckpoint = LinkTrafficTotals & {
  id: number; node_id: number; producer_id: string; forward_id: number; date: Date;
  link_id: number; workspace_id: number; generation: number; config_digest: string;
  updated_at: Date;
};
export interface LinkTrafficDeployment {
  link_id: number;
  generation: number;
  link: { workspace_id: number };
  binding_snapshot: unknown;
  placements: Array<{ node_id: number; role: string; generation: number; config_digest: string }>;
}

/** Transaction-scoped DI seam; lockCheckpoint must return a current, exclusively locked row. */
export interface LinkTrafficTransaction {
  findDeployment(linkId: number, generation: number): Promise<LinkTrafficDeployment | null>;
  lockCheckpoint(nodeId: number, sample: LinkTrafficSample, date: Date): Promise<LinkTrafficCheckpoint>;
  updateCheckpoint(id: number, totals: LinkTrafficTotals): Promise<void>;
  /** Must lock/check immutable daily attribution even for a zero delta. */
  incrementDailyTraffic(forwardId: number, workspaceId: number, date: Date, bytes: bigint): Promise<void>;
}
export interface LinkTrafficStore {
  transaction<T>(work: (tx: LinkTrafficTransaction) => Promise<T>): Promise<T>;
}
export class LinkTrafficError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 409 | 503) {
    super(code);
    this.name = "LinkTrafficError";
  }
}
const conflict = () => new LinkTrafficError("link_traffic_identity_conflict", 409);
const unauthorized = () => new LinkTrafficError("link_traffic_not_owned", 403);

/** Only immutable ownership/binding facts matter, not live targets, leases or ACKs. */
const HistoricalSpecSchema = z.object({
  spec: z.object({
    link_id: id, workspace_id: id, generation: id,
    ingress: z.object({ id, workspace_id: id }).passthrough(),
    bindings: z.array(z.object({ forward_id: id }).passthrough()),
  }).passthrough(),
}).passthrough();

function authorize(sample: LinkTrafficSample, nodeId: number, deployment: LinkTrafficDeployment | null): void {
  if (sample.node_id !== nodeId || !deployment || deployment.link_id !== sample.link_id
    || deployment.generation !== sample.generation || deployment.link.workspace_id !== sample.workspace_id) {
    throw unauthorized();
  }
  const snapshot = HistoricalSpecSchema.safeParse(deployment.binding_snapshot);
  if (!snapshot.success) throw unauthorized();
  const spec = snapshot.data.spec;
  if (spec.link_id !== sample.link_id || spec.workspace_id !== sample.workspace_id
    || spec.generation !== sample.generation || spec.ingress.id !== nodeId
    || spec.ingress.workspace_id !== sample.workspace_id
    || !spec.bindings.some((binding) => binding.forward_id === sample.forward_id)
    || !deployment.placements.some((placement) => placement.role === "ingress"
      && placement.node_id === nodeId && placement.generation === sample.generation
      && placement.config_digest === sample.config_digest)) throw unauthorized();
}

function assertIdentity(row: LinkTrafficCheckpoint, sample: LinkTrafficSample, nodeId: number, date: Date): void {
  if (row.node_id !== nodeId || row.producer_id !== sample.producer_id || row.forward_id !== sample.forward_id
    || row.date.getTime() !== date.getTime() || row.link_id !== sample.link_id
    || row.workspace_id !== sample.workspace_id || row.generation !== sample.generation
    || row.config_digest !== sample.config_digest) throw conflict();
}

/** MySQL-native no-op upserts avoid Prisma's read/create upsert race on a new identity. */
export function createPrismaLinkTrafficStore(client: Pick<PrismaClient, "$transaction"> = db): LinkTrafficStore {
  return {
    transaction: (work) => client.$transaction(async (tx) => work({
      findDeployment: (linkId, generation) => tx.linkDeployment.findUnique({
        where: { link_id_generation: { link_id: linkId, generation } },
        select: { link_id: true, generation: true, binding_snapshot: true,
          link: { select: { workspace_id: true } },
          placements: { select: { node_id: true, role: true, generation: true, config_digest: true } } },
      }),
      async lockCheckpoint(nodeId, sample, date) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO link_traffic_checkpoint
            (node_id, producer_id, forward_id, date, link_id, workspace_id, generation, config_digest)
          VALUES (${nodeId}, ${sample.producer_id}, ${sample.forward_id}, ${date}, ${sample.link_id},
            ${sample.workspace_id}, ${sample.generation}, ${sample.config_digest})
          ON DUPLICATE KEY UPDATE id = id`);
        const rows = await tx.$queryRaw<LinkTrafficCheckpoint[]>(Prisma.sql`
          SELECT id, node_id, producer_id, forward_id, date, link_id, workspace_id, generation,
            config_digest, bytes_in, bytes_out, connections, updated_at
          FROM link_traffic_checkpoint
          WHERE node_id = ${nodeId} AND producer_id = ${sample.producer_id}
            AND forward_id = ${sample.forward_id} AND date = ${date} FOR UPDATE`);
        if (rows.length !== 1) throw new Error("checkpoint_lock_failed");
        return rows[0]!;
      },
      async updateCheckpoint(checkpointId, totals) {
        // Authorization created a REPEATABLE READ snapshot before another
        // reporter could commit this row. FOR UPDATE sees the current row, but
        // Prisma's read-before-update can still report P2025 from that older
        // snapshot. Keep writes native too; the row is already locked above.
        // Raw SQL must explicitly maintain Prisma's @updatedAt receipt stamp.
        await tx.$executeRaw(Prisma.sql`
          UPDATE link_traffic_checkpoint
          SET bytes_in = ${totals.bytes_in}, bytes_out = ${totals.bytes_out},
            connections = ${totals.connections}, updated_at = ${new Date()}
          WHERE id = ${checkpointId}`);
      },
      async incrementDailyTraffic(forwardId, workspaceId, date, bytes) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO tunnel_traffic (tunnel_id, workspace_id, date, traffic, traffic_cost)
          VALUES (${forwardId}, ${workspaceId}, ${date}, 0, 0)
          ON DUPLICATE KEY UPDATE id = id`);
        const rows = await tx.$queryRaw<Array<{ id: number; workspace_id: number; traffic: number; traffic_cost: number }>>(Prisma.sql`
          SELECT id, workspace_id, traffic, traffic_cost FROM tunnel_traffic
          WHERE tunnel_id = ${forwardId} AND date = ${date} FOR UPDATE`);
        if (rows.length !== 1) throw new Error("daily_traffic_lock_failed");
        const row = rows[0]!;
        if (row.workspace_id !== workspaceId) throw conflict();
        // TunnelTraffic is the existing Float ledger. Fail closed rather than
        // rounding an unrepresentable daily sum across producers/batches.
        if (bytes > MAX_SAFE || ![row.traffic, row.traffic_cost].every((value) => Number.isFinite(value)
          && value >= 0 && value <= Number.MAX_SAFE_INTEGER - Number(bytes))) {
          throw new Error("daily_traffic_overflow");
        }
        if (bytes !== 0n) await tx.$executeRaw(Prisma.sql`
          UPDATE tunnel_traffic
          SET traffic = traffic + ${Number(bytes)}, traffic_cost = traffic_cost + ${Number(bytes)}
          WHERE id = ${row.id}`);
      },
    }), { maxWait: 5000, timeout: 30_000 }),
  };
}

export type LinkTrafficResult = { ok: true; accepted: LinkTrafficSample[] }
  | { ok: false; status: 400 | 403 | 409 | 503; reason: string };

/** ACK only after commit; replay/stale samples echo the input, not checkpoint maxima. */
export async function submitLinkTraffic(nodeId: number, raw: unknown,
  deps: { store: LinkTrafficStore } = { store: createPrismaLinkTrafficStore() }): Promise<LinkTrafficResult> {
  const parsed = LinkTrafficBatchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, reason: "invalid_link_traffic" };
  const samples = parsed.data.samples;
  if (samples.some((sample) => sample.node_id !== nodeId)) {
    return { ok: false, status: 403, reason: "link_traffic_not_owned" };
  }
  try {
    await deps.store.transaction(async (tx) => {
      const deployments = new Map<string, LinkTrafficDeployment | null>();
      for (const sample of samples) {
        const key = `${sample.link_id}:${sample.generation}`;
        if (!deployments.has(key)) deployments.set(key, await tx.findDeployment(sample.link_id, sample.generation));
        authorize(sample, nodeId, deployments.get(key)!);
      }

      // Lock ALL checkpoints before touching daily facts. Interleaving these
      // locks can deadlock two batches containing overlapping producer sets.
      const ordered = [...samples].sort((a, b) => a.forward_id - b.forward_id
        || a.date.localeCompare(b.date) || a.producer_id.localeCompare(b.producer_id));
      const checkpoints = new Map<string, { row: LinkTrafficCheckpoint; received: boolean }>();
      for (const sample of ordered) {
        const key = `${sample.forward_id}:${sample.date}:${sample.producer_id}`;
        const date = linkTrafficDate(sample.date)!;
        if (!checkpoints.has(key)) checkpoints.set(key, {
          row: { ...await tx.lockCheckpoint(nodeId, sample, date) }, received: false,
        });
        assertIdentity(checkpoints.get(key)!.row, sample, nodeId, date);
      }

      const daily = new Map<string, { sample: LinkTrafficSample; date: Date; bytes: bigint }>();
      for (const sample of ordered) {
        const entry = checkpoints.get(`${sample.forward_id}:${sample.date}:${sample.producer_id}`)!;
        const row = entry.row;
        const key = `${sample.forward_id}:${sample.date}`;
        if (!daily.has(key)) daily.set(key, { sample, date: row.date, bytes: 0n });
        const day = daily.get(key)!;
        if (day.sample.workspace_id !== sample.workspace_id) throw conflict();
        const totals = { bytes_in: BigInt(sample.bytes_in), bytes_out: BigInt(sample.bytes_out),
          connections: BigInt(sample.connections) };
        // Any decreasing field makes the WHOLE row stale: never mix counters
        // from a reset with a prior producer epoch's high-water marks.
        if (totals.bytes_in < row.bytes_in || totals.bytes_out < row.bytes_out || totals.connections < row.connections) continue;
        day.bytes += totals.bytes_in - row.bytes_in + totals.bytes_out - row.bytes_out;
        Object.assign(row, totals);
        // Equal/zero nonstale reports are received facts too. Prisma @updatedAt
        // stamps receipt; a stale sample must not freshen the summary timestamp.
        entry.received = true;
      }
      for (const { row, received } of checkpoints.values()) {
        if (received) await tx.updateCheckpoint(row.id, {
          bytes_in: row.bytes_in, bytes_out: row.bytes_out, connections: row.connections,
        });
      }
      for (const { sample, date, bytes } of daily.values()) {
        await tx.incrementDailyTraffic(sample.forward_id, sample.workspace_id, date, bytes);
      }
    });
    return { ok: true, accepted: samples };
  } catch (error) {
    if (error instanceof LinkTrafficError) return { ok: false, status: error.status, reason: error.code };
    return { ok: false, status: 503, reason: "link_traffic_storage_failure" };
  }
}

/** Bound actual streamed bytes (Content-Length alone is untrusted), then decode JSON. */
export async function readLinkTrafficBody(request: Request): Promise<unknown> {
  const invalid = () => new LinkTrafficError("invalid_link_traffic", 400);
  if (Number(request.headers.get("content-length")) > LINK_TRAFFIC_MAX_BODY_BYTES) throw invalid();
  if (!request.body) throw invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LINK_TRAFFIC_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
  } catch {
    throw invalid();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}
