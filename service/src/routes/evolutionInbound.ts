import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { config } from "../config.js";
import { enqueueDelivery } from "../lib/webhookFanout.js";
import { audit } from "../lib/audit.js";

/**
 * Inbound webhook receiver for Evolution.
 * URL sent to Evolution when we create an instance:
 *   {PUBLIC_BASE_URL}/v1/hooks/evolution/:evoName
 *
 * This route is PUBLIC (no API key) but protected by:
 *   - the unguessable evoName path segment (uuid-derived)
 *   - optionally EVOLUTION_INBOUND_TOKEN via header X-Evolution-Token
 *
 * It also handles CONNECTION_UPDATE / QRCODE_UPDATED to keep instance state in sync.
 */
export async function evolutionInboundRoutes(app: FastifyInstance) {
  app.post("/evolution/:evoName", async (req, reply) => {
    if (config.EVOLUTION_INBOUND_TOKEN) {
      const t = req.headers["x-evolution-token"];
      if (t !== config.EVOLUTION_INBOUND_TOKEN) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid token" } });
      }
    }

    const { evoName } = z.object({ evoName: z.string().min(1) }).parse(req.params);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = String(body.event ?? "unknown");

    const { rows } = await query<{
      id: string; tenant_id: string; webhook_url: string | null; webhook_events: string[];
    }>(
      `SELECT id, tenant_id, webhook_url, webhook_events
         FROM instances WHERE evolution_instance_name = $1 AND deleted_at IS NULL`,
      [evoName],
    );
    const inst = rows[0];
    if (!inst) {
      // Unknown instance — ack anyway so Evolution doesn't retry forever.
      req.log.warn({ evoName, event }, "inbound webhook for unknown instance");
      return reply.code(202).send({ received: true, matched: false });
    }

    // Keep our local state consistent with Evolution.
    try {
      if (event === "connection.update" || event === "CONNECTION_UPDATE") {
        const data = (body.data ?? {}) as { state?: string; wuid?: string };
        const mapped =
          data.state === "open" ? "connected" :
          data.state === "connecting" ? "connecting" :
          data.state === "close" ? "disconnected" : null;
        if (mapped) {
          await query(
            `UPDATE instances SET status=$2::instance_status,
               connected_number = COALESCE($3, connected_number),
               last_sync_at = now() WHERE id=$1`,
            [inst.id, mapped, data.wuid ? data.wuid.replace(/@.*$/, "") : null],
          );
        }
      } else if (event === "qrcode.updated" || event === "QRCODE_UPDATED") {
        const data = (body.data ?? {}) as { qrcode?: { base64?: string; code?: string } };
        await query(
          `UPDATE instances SET qr_code=$2, pairing_code=$3, status='connecting',
             qr_expires_at = now() + interval '60 seconds' WHERE id=$1`,
          [inst.id, data.qrcode?.base64 ?? null, data.qrcode?.code ?? null],
        );
      }
    } catch (err) {
      req.log.error({ err, evoName, event }, "failed to update local instance state");
    }

    // Fan-out to tenant webhook_url (if configured and event allowed).
    if (inst.webhook_url) {
      const allowed = inst.webhook_events.length === 0 || inst.webhook_events.includes(event);
      if (allowed) {
        await enqueueDelivery({
          tenantId: inst.tenant_id,
          instanceId: inst.id,
          eventType: event,
          targetUrl: inst.webhook_url,
          payload: { instance_id: inst.id, evolution_instance_name: evoName, event, data: body.data ?? body },
        });
      }
    }

    await audit({
      tenantId: inst.tenant_id, actor: "system", action: `webhook.inbound.${event}`,
      resourceType: "instance", resourceId: inst.id,
    });
    return reply.code(200).send({ received: true });
  });
}