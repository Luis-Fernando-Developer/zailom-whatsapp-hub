import crypto from "node:crypto";

/**
 * Produces a globally unique Evolution instance name for a (product, tenant, name) tuple.
 * Format: "<product>-<tenantShort>-<slug>-<rand4>"
 * Evolution accepts [A-Za-z0-9_-]. We enforce that.
 */
export function buildEvolutionInstanceName(product: string, tenantId: string, humanName: string): string {
  const slug = humanName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "inst";
  const tenantShort = tenantId.replace(/-/g, "").slice(0, 8);
  const rand = crypto.randomBytes(2).toString("hex");
  return `${product}-${tenantShort}-${slug}-${rand}`;
}