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
    const res = (await evolution.connect(inst.evolution_instance_name, body.number)) as any;

    // Evolution pode variar o envelope conforme o estado/versão da instância.
    // Normalize os formatos conhecidos para que Booking e Flow recebam o mesmo contrato.
    const qrCode =
      res?.base64 ??
      res?.qr_code ??
      res?.qrCode ??
      res?.qrcode?.base64 ??
      res?.qrcode?.qr_code ??
      res?.qrcode?.qrCode ??
      res?.instance?.base64 ??
      res?.instance?.qrcode?.base64 ??
      null;
    const pairingCode =
      res?.pairingCode ??
      res?.pairing_code ??
      res?.code ??
      res?.instance?.pairingCode ??
      res?.instance?.code ??
      null;

    await query(
      `UPDATE instances SET status='connecting', qr_code=$2, pairing_code=$3,
         qr_expires_at = now() + interval '60 seconds' WHERE id=$1`,
      [id, qrCode, pairingCode],
    );
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.connect", resourceId: id });
    return {
      qr_code: qrCode,
      qrCode,
      base64: qrCode,
      pairing_code: pairingCode,
      pairingCode,
      expires_in: 60,
      // Mantém o payload original para diagnóstico sem quebrar os consumidores existentes.
      raw: res,
    };
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
    // Use Evolution's canonical connectionState endpoint for the status.
    // fetchInstances can lag or expose the state under different fields.
    const stateRes = await evolution.connectionState(inst.evolution_instance_name) as
      | { instance?: { state?: string; status?: string; connectionStatus?: string } }
      | { state?: string; status?: string; connectionStatus?: string }
      | null;

    const stateObj = (stateRes as { instance?: Record<string, unknown> } | null)?.instance ?? stateRes ?? {};
    const rawState =
      (stateObj as Record<string, unknown>).state ??
      (stateObj as Record<string, unknown>).status ??
      (stateObj as Record<string, unknown>).connectionStatus ??
      "unknown";
    const state = String(rawState).trim().toLowerCase();
    const mapped =
      ["open", "connected", "online"].includes(state) ? "connected" :
      ["close", "closed", "disconnected", "offline"].includes(state) ? "disconnected" :
      ["connecting", "pairing"].includes(state) ? "connecting" :
      ["qrcode", "qr", "qr_code"].includes(state) ? "qrcode" :
      inst.status;

    // Fetch the instance details only for the connected number.
    const instancesRes = await evolution.fetchInstances(inst.evolution_instance_name) as
      | Record<string, any>[]
      | Record<string, any>
      | null;
    // Normalize the response to an array before selecting the matching instance.
    // This avoids relying on TypeScript's narrowing of an array/object union.
    const instances: Record<string, any>[] = Array.isArray(instancesRes)
      ? instancesRes
      : instancesRes && typeof instancesRes === "object"
        ? [instancesRes]
        : [];
    const first: Record<string, any> = instances.find((item) =>
      item?.instance?.instanceName === inst.evolution_instance_name ||
      item?.instanceName === inst.evolution_instance_name ||
      item?.name === inst.evolution_instance_name
    ) ?? instances[0] ?? {};
    const raw = (first.instance && typeof first.instance === "object" ? first.instance : first) as Record<string, any>;
    // Evolution/Baileys varia o campo do número entre versões: owner, ownerJid,
    // number ou remoteJid. Normalizamos JID e sufixo de dispositivo para E.164.
    const candidate = raw.owner ?? raw.ownerJid ?? raw.number ?? raw.phoneNumber ??
      raw.phone ?? raw.remoteJid ?? first.owner ?? first.ownerJid ??
      first.number ?? first.phoneNumber ?? first.phone ?? null;
    const connectedNumber = candidate
      ? String(candidate).split("@")[0]?.replace(/:\d+$/, "").replace(/\D/g, "") || null
      : null;
    await query(
      `UPDATE instances SET status=$2::instance_status,
         connected_number=COALESCE($3, connected_number),
         last_sync_at=now() WHERE id=$1`,
      [id, mapped, connectedNumber],
    );
    return { status: mapped, connected_number: connectedNumber, raw: stateRes };
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
  const getSettings = async (req: import("fastify").FastifyRequest) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.getSettings(inst.evolution_instance_name);
  };
  app.get("/:id/settings", { preHandler: requireScope("instances:read") }, getSettings);
  // Booking compatibility alias: its contract uses /settings/find.
  app.get("/:id/settings/find", { preHandler: requireScope("instances:read") }, getSettings);

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

  // ---------------------------------------------------------- Evolution Bot compatibility (Booking)
  // Booking uses /v1/instances/:id/bot; the tenant is always resolved from the API key.
  app.get("/:id/bot", { preHandler: requireScope("instances:read") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    try {
      const result = await evolution.raw("GET", `/evolutionBot/find/${encodeURIComponent(inst.evolution_instance_name)}`) as any;
      return { bot: result?.evolutionBot ?? result?.bot ?? result ?? null };
    } catch (error: any) {
      const status = error?.details?.status ?? error?.statusCode;
      if (status === 404) return { bot: null };
      throw error;
    }
  });

  const findEvolutionBot = async (instanceName: string): Promise<{ bot: Record<string, unknown> | null; botId: string | null }> => {
    let found: any;
    try {
      found = await evolution.raw("GET", `/evolutionBot/find/${encodeURIComponent(instanceName)}`);
    } catch (error: any) {
      const status = error?.details?.status ?? error?.statusCode;
      if (status === 404) return { bot: null, botId: null };
      throw error;
    }

    // Normalize the common Evolution v2 response envelopes.
    let candidate: any = found;
    for (let depth = 0; depth < 4; depth++) {
      if (Array.isArray(candidate)) { candidate = candidate[0] ?? null; continue; }
      if (!candidate || typeof candidate !== "object") return { bot: null, botId: null };
      const nested = candidate.evolutionBot ?? candidate.bot ?? candidate.data;
      if (nested && nested !== candidate) { candidate = nested; continue; }
      break;
    }
    if (!candidate || typeof candidate !== "object") return { bot: null, botId: null };
    const bot = candidate as Record<string, any>;
    const candidateId = bot.evolutionBotId ?? bot.evolutionBot?.evolutionBotId ?? bot.evolutionBot?.id ?? bot.id ?? bot.botId ?? bot.uuid ?? bot.data?.evolutionBotId ?? bot.data?.id;
    return { bot, botId: candidateId == null || String(candidateId).trim() === "" ? null : String(candidateId) };
  };

  app.post("/:id/bot", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.record(z.unknown()).parse(req.body ?? {});
    const inst = await loadInstance(req.tenant!.id, id);
    const instanceName = inst.evolution_instance_name;

    // Evolution v2 updates an existing bot by ID and instance name. Check first
    // rather than attempting create and relying on an error to detect duplicates.
    const existing = await findEvolutionBot(instanceName);
    if (existing.bot && !existing.botId) {
      throw new Error("Evolution Bot exists, but GET /evolutionBot/find did not return its ID; refusing to create a duplicate.");
    }
    // Booking's UI uses title-cased labels and a few UI-only fields. Evolution v2
    // expects lowercase enum values, triggerValue (not triggerKeyword), and ignoreJids as an array.
    const rawTriggerType = String(body.triggerType ?? "keyword").trim().toLowerCase();
    const rawTriggerOperator = String(body.triggerOperator ?? "contains").trim().toLowerCase();
    const triggerType = rawTriggerType === "all" || rawTriggerType === "all messages"
      ? "all"
      : "keyword";
    const operatorMap: Record<string, string> = {
      contains: "contains",
      equals: "equals",
      startswith: "startsWith",
      endswith: "endsWith",
      regex: "regex",
      none: "none",
    };
    const triggerOperator = rawTriggerType === "none"
      ? "none"
      : (operatorMap[rawTriggerOperator.replace(/[\\s_-]/g, "")] ?? operatorMap[rawTriggerOperator] ?? "contains");
    const rawIgnoreJids = body.ignoreJids;
    const ignoreJids = Array.isArray(rawIgnoreJids)
      ? rawIgnoreJids.map(String).map((v) => v.trim()).filter(Boolean)
      : typeof rawIgnoreJids === "string"
        ? rawIgnoreJids.split(",").map((v) => v.trim()).filter(Boolean)
        : [];
    const evolutionBody: Record<string, unknown> = {
      enabled: body.enabled !== false,
      apiUrl: typeof body.apiUrl === "string" ? body.apiUrl.trim().replace(/\\/$/, "") : "",
      triggerType,
      triggerOperator,
      triggerValue: rawTriggerType === "none" ? "" : String(body.triggerValue ?? body.triggerKeyword ?? ""),
      expire: Number(body.expire ?? 0),
      keywordFinish: String(body.keywordFinish ?? "#SAIR"),
      delayMessage: Number(body.delayMessage ?? 1000),
      unknownMessage: String(body.unknownMessage ?? "Mensagem não reconhecida"),
      listeningFromMe: body.listeningFromMe === true,
      stopBotFromMe: body.stopBotFromMe === true,
      keepOpen: body.keepOpen === true,
      debounceTime: Number(body.debounceTime ?? 0),
      ignoreJids,
    };
    if (typeof body.apiKey === "string" && body.apiKey.trim()) evolutionBody.apiKey = body.apiKey.trim();

    const result = existing.botId
      ? await evolution.raw("PUT", `/evolutionBot/update/${encodeURIComponent(existing.botId)}/${encodeURIComponent(instanceName)}`, evolutionBody)
      : await evolution.raw("POST", `/evolutionBot/create/${encodeURIComponent(instanceName)}`, evolutionBody);

    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.bot.set", resourceId: id });
    return { bot: (result as any)?.evolutionBot ?? (result as any)?.bot ?? result };
  });

  app.delete("/:id/bot", { preHandler: requireScope("instances:write") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    const existing = await findEvolutionBot(inst.evolution_instance_name);
    if (!existing.botId) {
      await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.bot.delete", resourceId: id });
      return { success: true, raw: { message: "No Evolution Bot configured" } };
    }
    const result = await evolution.raw(
      "DELETE",
      `/evolutionBot/delete/${encodeURIComponent(existing.botId)}/${encodeURIComponent(inst.evolution_instance_name)}`,
    );
    await audit({ tenantId: req.tenant!.id, actor: `api_key:${req.tenant!.apiKeyId}`, action: "instance.bot.delete", resourceId: id });
    return { success: true, raw: result };
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