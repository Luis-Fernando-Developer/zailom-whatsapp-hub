import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db.js";
import { Errors } from "../errors.js";
import { parseApiKey, verifySecret } from "../lib/apiKeys.js";
import { config } from "../config.js";

/**
 * Bearer API-key auth. Resolves tenant + scopes and attaches to request.tenant.
 * Also accepts header `X-Api-Key` for convenience.
 */
export async function requireTenant(req: FastifyRequest, _reply: FastifyReply) {
  const header =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["x-api-key"] as string | undefined);
  if (!header) throw Errors.unauthorized("Missing Authorization header");

  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  const parsed = parseApiKey(raw);
  if (!parsed) throw Errors.unauthorized("Malformed API key");

  const { rows } = await query<{
    id: string;
    tenant_id: string;
    key_hash: string;
    scopes: string[];
    revoked_at: string | null;
    product: "booking" | "flow" | "other";
    tenant_name: string;
  }>(
    `SELECT k.id, k.tenant_id, k.key_hash, k.scopes, k.revoked_at,
            t.product, t.name AS tenant_name
       FROM api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_prefix = $1`,
    [parsed.prefix],
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw Errors.unauthorized("Unknown or revoked API key");

  const ok = await verifySecret(row.key_hash, parsed.secret);
  if (!ok) throw Errors.unauthorized("Invalid API key");

  req.tenant = {
    id: row.tenant_id,
    product: row.product,
    name: row.tenant_name,
    apiKeyId: row.id,
    scopes: row.scopes ?? [],
  };

  // fire-and-forget usage stamp
  void query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
}

export function requireAdmin(req: FastifyRequest) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== config.ADMIN_TOKEN) throw Errors.forbidden("Admin token required");
}

/** Scope check: e.g. requireScope('messages:send'). Accepts 'messages:*' or 'admin'. */
export function requireScope(scope: string) {
  return async (req: FastifyRequest) => {
    if (!req.tenant) throw Errors.unauthorized();
    const [group] = scope.split(":");
    const ok =
      req.tenant.scopes.includes(scope) ||
      req.tenant.scopes.includes(`${group}:*`) ||
      req.tenant.scopes.includes("admin");
    if (!ok) throw Errors.forbidden(`Missing scope: ${scope}`);
  };
}