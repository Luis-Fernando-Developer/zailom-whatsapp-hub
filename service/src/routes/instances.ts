import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { requireTenant, requireScope } from "../middleware/auth.js";
import { evolution } from "../lib/evolution.js";
import { buildEvolutionInstanceName } from "../lib/instanceName.js";
import { loadInstance } from "../lib/instanceLookup.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { Errors } from "../errors.js";

export async function instanceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);

  // ---------------------------------------------------------- list
  app.get("/all-instances", { preHandler: requireScope("instances:read") }, async (req) => {
    const { rows } = await query(
      `SELECT id, name, evolution_instance_name, status, connected_number,
              webhook_url, webhook_events, last_sync_at, created_at, updated_at
         FROM instances
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [req.tenant!.id],
    );
    return { data: rows };
  });

  // ---------------------------------------------------------- create
  const createBody = z.object({
    name: z.string().min(1).max(64),
    webhook_url: z.string().url().optional(),
    webhook_events: z.array(z.string()).optional(),
    webhook_by_events: z.boolean().optional(),
    webhook_base64: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  });

  app.post("/create", { preHandler: requireScope("instances:write") }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const tenant = req.tenant!;
    const evoName = buildEvolutionInstanceName(tenant.product, tenant.id, body.name);
    const inboundWebhook = `${config.PUBLIC_BASE_URL}/v1/hooks/evolution/${encodeURIComponent(evoName)}`;

    // 1) create on Evolution FIRST — if that fails we don't have a dangling row
    const evoResponse = (await evolution.createInstance({
      instanceName: evoName,
      qrcode: true,
      webhook: {
        url: inboundWebhook,
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "SEND_MESSAGE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
      },
    })) as { instance?: { instanceId?: string }; hash?: string; qrcode?: { code?: string; base64?: string } };

    const evoInstanceId = evoResponse?.instance?.instanceId ?? null;
    const evoToken = evoResponse?.hash ?? null;
    const qrBase64 = evoResponse?.qrcode?.base64 ?? null;

    // 2) persist
    const { rows } = await query<{ id: string }>(
      `INSERT INTO instances
         (tenant_id, name, evolution_instance_name, evolution_instance_id, evolution_token,
          status, qr_code, webhook_url, webhook_events, webhook_by_events, webhook_base64, config)
       VALUES ($1,$2,$3,$4,$5,'connecting',$6,$7,$8,$9,$10,COALESCE($11::jsonb,'{}'::jsonb))
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         evolution_instance_name = EXCLUDED.evolution_instance_name,
         evolution_instance_id = EXCLUDED.evolution_instance_id,
         evolution_token = EXCLUDED.evolution_token,
         status = EXCLUDED.status,
         qr_code = EXCLUDED.qr_code
       RETURNING id`,
      [
        tenant.id, body.name, evoName, evoInstanceId, evoToken,
        qrBase64, body.webhook_url ?? null, body.webhook_events ?? [],
        body.webhook_by_events ?? false, body.webhook_base64 ?? false,
        JSON.stringify(body.config ?? {}),
      ],
    );
    const id = rows[0]!.id;
    await audit({ tenantId: tenant.id, actor: `api_key:${tenant.apiKeyId}`, action: "instance.create", resourceType: "instance", resourceId: id, payload: { evoName } });
    return reply.code(201).send({ id, evolution_instance_name: evoName, qr_code: qrBase64, status: "connecting" });
  });

  // ---------------------------------------------------------- get by id
  app.get("/:id", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return inst;
  });

  // ---------------------------------------------------------- connect (QR/pairing)
  app.post("/:id/connect", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ number: z.string().optional() }).parse(req.body ?? {});
    const inst = await loadInstance(req.tenant!.id, id);
    const res = (await evolution.connect(inst.evolution_instance_name, body.number)) as {
      base64?: string; code?: string; pairingCode?: string;
    };
    await query(
      `UPDATE instances SET status='connecting', qr_code=$2, pairing_code=$3,
         qr_expires_at = now() + interval '60 seconds' WHERE id=$1`,
      [id, res?.base64 ?? null, res?.pairingCode ?? res?.code ?? null],
    );
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.connect", resourceId: id });
    return { qr_code: res?.base64 ?? null, pairing_code: res?.pairingCode ?? res?.code ?? null, expires_in: 60 };
  });

  // ---------------------------------------------------------- connection state (mirrors Evolution's path shape)
  app.get("/connectionState/:id", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    const res = await evolution.connectionState(inst.evolution_instance_name);
    return res;
  });

  // ---------------------------------------------------------- refresh (sync status)
  app.post("/:id/refresh-status", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    const res = (await evolution.connectionState(inst.evolution_instance_name)) as {
      instance?: { state?: string; wuid?: string };
    };
    const state = res?.instance?.state ?? "unknown";
    const wuid = res?.instance?.wuid ?? null;
    const mapped =
      state === "open" ? "connected" :
      state === "connecting" ? "connecting" :
      state === "close" ? "disconnected" : inst.status;
    await query(
      `UPDATE instances SET status=$2::instance_status, connected_number=COALESCE($3, connected_number),
         last_sync_at=now() WHERE id=$1`,
      [id, mapped, wuid ? wuid.replace(/@.*$/, "") : null],
    );
    return { status: mapped, connected_number: wuid, raw: res };
  });

  // ---------------------------------------------------------- restart
  app.post("/:id/restart", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    const res = await evolution.restart(inst.evolution_instance_name);
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.restart", resourceId: id });
    return { ok: true, raw: res };
  });

  // ---------------------------------------------------------- logout
  app.post("/:id/logout", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    await evolution.logout(inst.evolution_instance_name);
    await query(`UPDATE instances SET status='disconnected', connected_number=NULL WHERE id=$1`, [id]);
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.logout", resourceId: id });
    return { ok: true };
  });

  // ---------------------------------------------------------- delete
  app.delete("/:id/delete", { preHandler: requireScope("instances:write") }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    try {
      await evolution.logout(inst.evolution_instance_name).catch(() => undefined);
      await evolution.deleteInstance(inst.evolution_instance_name);
    } catch (err) {
      // Even if Evolution errors (already gone), mark deleted locally so the tenant can retry.
      req.log.warn({ err }, "evolution delete failed, marking deleted anyway");
    }
    await query(
      `UPDATE instances SET status='deleted', deleted_at=now(), qr_code=NULL, connected_number=NULL WHERE id=$1`,
      [id],
    );
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.delete", resourceId: id });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- settings
  app.get("/:id/settings", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.getSettings(inst.evolution_instance_name);
  });

  const settingsBody = z.object({
    rejectCall: z.boolean().optional(),
    msgCall: z.string().optional(),
    groupsIgnore: z.boolean().optional(),
    alwaysOnline: z.boolean().optional(),
    readMessages: z.boolean().optional(),
    readStatus: z.boolean().optional(),
    syncFullHistory: z.boolean().optional(),
  });
  app.post("/:id/settings/set", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = settingsBody.parse(req.body);
    const inst = await loadInstance(req.tenant!.id, id);
    const res = await evolution.setSettings(inst.evolution_instance_name, body);
    await query(`UPDATE instances SET settings = settings || $2::jsonb WHERE id=$1`, [id, JSON.stringify(body)]);
    return res;
  });

  // ---------------------------------------------------------- webhook (config del webhook OUT)
  app.get("/:id/webhook/find", { preHandler: requireScope("webhooks:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return {
      url: inst.webhook_url,
      byEvents: inst.webhook_by_events,
      base64: inst.webhook_base64,
      events: inst.webhook_events,
    };
  });

  const webhookBody = z.object({
    url: z.string().url().nullable(),
    byEvents: z.boolean().optional(),
    base64: z.boolean().optional(),
    events: z.array(z.string()).optional(),
  });
  app.post("/:id/webhook/set", { preHandler: requireScope("webhooks:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = webhookBody.parse(req.body);
    await loadInstance(req.tenant!.id, id);
    await query(
      `UPDATE instances SET webhook_url=$2, webhook_by_events=$3, webhook_base64=$4, webhook_events=$5 WHERE id=$1`,
      [id, body.url, body.byEvents ?? false, body.base64 ?? false, body.events ?? []],
    );
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.webhook.set", resourceId: id, payload: body });
    return { ok: true };
  });

  // ---------------------------------------------------------- generic passthrough helpers
  // (messages, chat, business, template are separate route files for clarity)
}

/** Also exposed at /v1/instance/connectionState/:id per the original spec. */
export async function instanceAliasRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);
  app.get("/connectionState/:id", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.connectionState(inst.evolution_instance_name);
  });
}