import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, withTx } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { generateApiKey, hashSecret } from "../lib/apiKeys.js";
import { audit } from "../lib/audit.js";
import { Errors } from "../errors.js";

/**
 * Admin-only. Protected by X-Admin-Token header.
 * Booking/Flow bootstrap use these to provision their tenants and mint api keys.
 */
export async function adminRoutes(app: FastifyInstance) {
  // Global admin gate
  app.addHook("preHandler", async (req) => requireAdmin(req));

  // -------------------------------------------------------- create tenant
  const createTenantBody = z.object({
    product: z.enum(["booking", "flow", "other"]),
    product_tenant_id: z.string().min(1),
    name: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
  });

  app.post("/tenants", async (req, reply) => {
    const body = createTenantBody.parse(req.body);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO tenants (product, product_tenant_id, name, metadata)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (product, product_tenant_id)
         DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata
       RETURNING id`,
      [body.product, body.product_tenant_id, body.name, JSON.stringify(body.metadata ?? {})],
    );
    const id = rows[0]!.id;
    await audit({ tenantId: id, actor: "admin", action: "tenant.upsert", payload: body });
    return reply.code(201).send({ id, ...body });
  });

  // -------------------------------------------------------- list tenants
  app.get("/tenants", async () => {
    const { rows } = await query(`SELECT id, product, product_tenant_id, name, created_at FROM tenants ORDER BY created_at DESC`);
    return { data: rows };
  });

  // -------------------------------------------------------- mint api key
  const mintBody = z.object({
    tenant_id: z.string().uuid(),
    name: z.string().min(1),
    scopes: z.array(z.string()).optional(),
  });

  app.post("/api-keys", async (req, reply) => {
    const body = mintBody.parse(req.body);
    const { full, prefix, secret } = generateApiKey();
    const hash = await hashSecret(secret);
    const { rows } = await withTx(async (c) => {
      const t = await c.query(`SELECT id FROM tenants WHERE id=$1`, [body.tenant_id]);
      if (t.rowCount === 0) throw Errors.notFound("tenant");
      const scopes = body.scopes && body.scopes.length > 0
        ? body.scopes
        : ["instances:*", "messages:*", "chat:*", "business:*", "template:*", "webhooks:*"];
      return c.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.tenant_id, body.name, prefix, hash, scopes],
      );
    });
    await audit({ tenantId: body.tenant_id, actor: "admin", action: "api_key.create", resourceId: rows[0]!.id });
    return reply.code(201).send({
      id: rows[0]!.id,
      tenant_id: body.tenant_id,
      name: body.name,
      api_key: full,
      warning: "This key will NOT be shown again. Store it in the tenant's secret manager now.",
    });
  });

  // -------------------------------------------------------- list keys
  app.get("/api-keys", async (req) => {
    const q = z.object({ tenant_id: z.string().uuid().optional() }).parse(req.query);
    const { rows } = await query(
      `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
         FROM api_keys
        ${q.tenant_id ? "WHERE tenant_id = $1" : ""}
        ORDER BY created_at DESC`,
      q.tenant_id ? [q.tenant_id] : [],
    );
    return { data: rows };
  });

  // -------------------------------------------------------- revoke key
  app.delete("/api-keys/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query(`UPDATE api_keys SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL`, [id]);
    if (r.rowCount === 0) throw Errors.notFound("api_key");
    await audit({ tenantId: null, actor: "admin", action: "api_key.revoke", resourceId: id });
    return reply.code(204).send();
  });
}