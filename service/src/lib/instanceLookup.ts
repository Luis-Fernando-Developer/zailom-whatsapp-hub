import { query } from "../db.js";
import { Errors } from "../errors.js";

export interface InstanceRow {
  id: string;
  tenant_id: string;
  name: string;
  evolution_instance_name: string;
  evolution_instance_id: string | null;
  evolution_token: string | null;
  status: string;
  connected_number: string | null;
  qr_code: string | null;
  pairing_code: string | null;
  qr_expires_at: string | null;
  webhook_url: string | null;
  webhook_events: string[];
  webhook_by_events: boolean;
  webhook_base64: boolean;
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadInstance(tenantId: string, instanceId: string): Promise<InstanceRow> {
  const { rows } = await query<InstanceRow>(
    `SELECT * FROM instances WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
    [instanceId, tenantId],
  );
  const row = rows[0];
  if (!row) throw Errors.notFound("instance");
  return row;
}