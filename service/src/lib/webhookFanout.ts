import crypto from "node:crypto";
import { request } from "undici";
import { config } from "../config.js";
import { query } from "../db.js";

/**
 * Persistent, retriable outbound webhook delivery.
 *
 * 1. `enqueue()` inserts a row in webhook_deliveries with signature.
 * 2. `startWorker()` polls pending rows every 2s and posts them.
 * 3. On failure it backs off: 1s, 5s, 30s, 5min, 30min, 2h (max_attempts=6).
 *
 * Signature: X-Zailom-Signature = "sha256=" + hex(HMAC-SHA256(payload, WEBHOOK_SIGNING_SECRET))
 * Timestamp: X-Zailom-Timestamp = ISO-8601 (included in signed payload)
 */

const BACKOFF_SECS = [1, 5, 30, 300, 1800, 7200];

export function signPayload(payload: string): string {
  const h = crypto.createHmac("sha256", config.WEBHOOK_SIGNING_SECRET);
  h.update(payload);
  return `sha256=${h.digest("hex")}`;
}

export async function enqueueDelivery(opts: {
  tenantId: string;
  instanceId: string | null;
  eventType: string;
  targetUrl: string;
  payload: unknown;
}): Promise<void> {
  const body = JSON.stringify({
    event: opts.eventType,
    timestamp: new Date().toISOString(),
    data: opts.payload,
  });
  const signature = signPayload(body);
  await query(
    `INSERT INTO webhook_deliveries
      (tenant_id, instance_id, event_type, target_url, payload, signature)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [opts.tenantId, opts.instanceId, opts.eventType, opts.targetUrl, body, signature],
  );
}

async function attemptDelivery(row: {
  id: string;
  target_url: string;
  payload: string;
  signature: string;
  attempt: number;
  max_attempts: number;
  event_type: string;
}) {
  const nextAttempt = row.attempt + 1;
  try {
    const res = await request(row.target_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "zailom-wa-service/1.0",
        "x-zailom-signature": row.signature,
        "x-zailom-event": row.event_type,
        "x-zailom-delivery-id": row.id,
      },
      body: row.payload,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    await res.body.dump();
    if (ok) {
      await query(
        `UPDATE webhook_deliveries SET status='delivered', delivered_at=now(),
           last_status_code=$2, attempt=$3, last_error=NULL WHERE id=$1`,
        [row.id, res.statusCode, nextAttempt],
      );
      return;
    }
    await reschedule(row.id, nextAttempt, row.max_attempts, res.statusCode, `HTTP ${res.statusCode}`);
  } catch (err) {
    await reschedule(row.id, nextAttempt, row.max_attempts, null, (err as Error).message);
  }
}

async function reschedule(
  id: string,
  attempt: number,
  maxAttempts: number,
  statusCode: number | null,
  errMsg: string,
) {
  if (attempt >= maxAttempts) {
    await query(
      `UPDATE webhook_deliveries SET status='dead', attempt=$2, last_status_code=$3, last_error=$4 WHERE id=$1`,
      [id, attempt, statusCode, errMsg.slice(0, 500)],
    );
    return;
  }
  const backoffSec = BACKOFF_SECS[Math.min(attempt, BACKOFF_SECS.length - 1)]!;
  await query(
    `UPDATE webhook_deliveries
       SET attempt=$2, last_status_code=$3, last_error=$4,
           next_attempt_at = now() + ($5 || ' seconds')::interval
     WHERE id=$1`,
    [id, attempt, statusCode, errMsg.slice(0, 500), String(backoffSec)],
  );
}

export function startWorker() {
  const tick = async () => {
    try {
      // Lock-and-claim: pick up to 20 due deliveries. `FOR UPDATE SKIP LOCKED`
      // is safe if we ever run multiple replicas.
      const { rows } = await query<{
        id: string;
        target_url: string;
        payload: string;
        signature: string;
        attempt: number;
        max_attempts: number;
        event_type: string;
      }>(
        `WITH due AS (
           SELECT id FROM webhook_deliveries
           WHERE status='pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at ASC
           LIMIT 20 FOR UPDATE SKIP LOCKED
         )
         UPDATE webhook_deliveries wd SET updated_at = now()
         FROM due WHERE wd.id = due.id
         RETURNING wd.id, wd.target_url, wd.payload::text as payload,
                   wd.signature, wd.attempt, wd.max_attempts, wd.event_type`,
      );
      for (const r of rows) {
        // fire in parallel but bounded (20)
        void attemptDelivery(r);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[webhook-worker] tick error", err);
    }
  };
  const handle = setInterval(tick, 2_000);
  return () => clearInterval(handle);
}