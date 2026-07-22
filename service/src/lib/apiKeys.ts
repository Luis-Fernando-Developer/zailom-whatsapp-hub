import argon2 from "argon2";
import crypto from "node:crypto";

/**
 * API key format:  zwa_live_<prefix>_<secret>
 *   - prefix: 12 hex chars, stored in api_keys.key_prefix (unique, indexable)
 *   - secret: 40 hex chars, only its argon2id hash is stored
 * The full key is shown to the caller ONCE at creation and never again.
 */

const KEY_REGEX = /^zwa_live_([a-f0-9]{12})_([a-f0-9]{40})$/;

export function generateApiKey(): { full: string; prefix: string; secret: string } {
  const prefix = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(20).toString("hex");
  return { full: `zwa_live_${prefix}_${secret}`, prefix, secret };
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const m = KEY_REGEX.exec(raw.trim());
  if (!m) return null;
  return { prefix: m[1]!, secret: m[2]! };
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}