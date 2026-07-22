import { query } from "../db.js";

export async function audit(entry: {
  tenantId: string | null;
  actor: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  statusCode?: number;
  payload?: unknown;
  error?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (tenant_id, actor, action, resource_type, resource_id, status_code, payload, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        entry.tenantId,
        entry.actor,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.statusCode ?? null,
        JSON.stringify(entry.payload ?? {}),
        entry.error ?? null,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] insert failed", err);
  }
}