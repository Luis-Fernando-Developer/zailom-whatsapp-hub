import { request } from "undici";
import { config } from "../config.js";
import { Errors } from "../errors.js";

/**
 * Thin wrapper around Evolution API v2. Uses the GLOBAL API key server-side
 * (env EVOLUTION_GLOBAL_API_KEY) — never exposed to service clients.
 *
 * All calls surface upstream errors as ApiError(502) with the upstream body
 * in `details` so the API caller can debug without leaking creds.
 */

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function evo(method: Method, path: string, body?: unknown): Promise<unknown> {
  const url = `${config.EVOLUTION_BASE_URL.replace(/\/$/, "")}${path}`;
  const res = await request(url, {
    method,
    headers: {
      apikey: config.EVOLUTION_GLOBAL_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.body.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (res.statusCode >= 400) {
    throw Errors.upstream(`Evolution ${res.statusCode} on ${method} ${path}`, {
      status: res.statusCode,
      body: parsed,
    });
  }
  return parsed;
}

export const evolution = {
  raw: evo,

  // --- Instance lifecycle -------------------------------------------------
  createInstance: (payload: {
    instanceName: string;
    integration?: string;
    qrcode?: boolean;
    webhook?: { url: string; byEvents?: boolean; base64?: boolean; events?: string[]; headers?: Record<string, string> };
  }) => evo("POST", `/instance/create`, { integration: "WHATSAPP-BAILEYS", qrcode: true, ...payload }),

  fetchInstances: (instanceName?: string) =>
    evo("GET", `/instance/fetchInstances${instanceName ? `?instanceName=${encodeURIComponent(instanceName)}` : ""}`),

  connect: (instanceName: string, number?: string) =>
    evo("GET", `/instance/connect/${encodeURIComponent(instanceName)}${number ? `?number=${encodeURIComponent(number)}` : ""}`),

  connectionState: (instanceName: string) =>
    evo("GET", `/instance/connectionState/${encodeURIComponent(instanceName)}`),

  restart: (instanceName: string) => evo("PUT", `/instance/restart/${encodeURIComponent(instanceName)}`),
  logout: (instanceName: string) => evo("DELETE", `/instance/logout/${encodeURIComponent(instanceName)}`),
  deleteInstance: (instanceName: string) => evo("DELETE", `/instance/delete/${encodeURIComponent(instanceName)}`),

  // --- Settings -----------------------------------------------------------
  getSettings: (instanceName: string) => evo("GET", `/settings/find/${encodeURIComponent(instanceName)}`),
  setSettings: (instanceName: string, body: Record<string, unknown>) =>
    evo("POST", `/settings/set/${encodeURIComponent(instanceName)}`, body),

  // --- Webhook ------------------------------------------------------------
  getWebhook: (instanceName: string) => evo("GET", `/webhook/find/${encodeURIComponent(instanceName)}`),

  // Evolution 2.3.x deployments differ on the webhook/set request envelope:
  // some accept { webhook: {...} }, while others accept a flat payload.
  // Prefer the nested contract (which preserves custom headers on 2.3.7),
  // read the saved config back, and only then try the flat compatibility form.
  setWebhook: async (instanceName: string, body: Record<string, unknown>) => {
    const url = `/webhook/set/${encodeURIComponent(instanceName)}`;
    const normalized: Record<string, unknown> = {
      enabled: body.enabled ?? true,
      url: body.url,
      byEvents: body.byEvents ?? body.webhookByEvents ?? false,
      base64: body.base64 ?? body.webhookBase64 ?? false,
      events: body.events ?? [],
      ...(body.headers && typeof body.headers === "object" ? { headers: body.headers } : {}),
    };
    const nested = { webhook: normalized };
    const flat = {
      ...normalized,
      webhookByEvents: normalized.byEvents,
      webhookBase64: normalized.base64,
    };
    let nestedError: unknown;
    try {
      const result = await evo("POST", url, nested);
      const expectedHeaders = normalized.headers as Record<string, string> | undefined;
      if (!expectedHeaders || Object.keys(expectedHeaders).length === 0) return result;

      const saved = await evo("GET", `/webhook/find/${encodeURIComponent(instanceName)}`) as any;
      const config = saved?.webhook?.webhook ?? saved?.webhook ?? saved?.data?.webhook ?? saved?.data ?? saved;
      const actualHeaders = config?.headers;
      const headersMatch = actualHeaders && typeof actualHeaders === "object" &&
        Object.entries(expectedHeaders).every(([key, value]) => {
          const actualKey = Object.keys(actualHeaders).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
          return actualKey !== undefined && actualHeaders[actualKey] === value;
        });
      if (headersMatch) return result;
    } catch (err) {
      nestedError = err;
    }

    try {
      const result = await evo("POST", url, flat);
      const expectedHeaders = normalized.headers as Record<string, string> | undefined;
      if (!expectedHeaders || Object.keys(expectedHeaders).length === 0) return result;
      const saved = await evo("GET", `/webhook/find/${encodeURIComponent(instanceName)}`) as any;
      const config = saved?.webhook?.webhook ?? saved?.webhook ?? saved?.data?.webhook ?? saved?.data ?? saved;
      const actualHeaders = config?.headers;
      const headersMatch = actualHeaders && typeof actualHeaders === "object" &&
        Object.entries(expectedHeaders).every(([key, value]) => {
          const actualKey = Object.keys(actualHeaders).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
          return actualKey !== undefined && actualHeaders[actualKey] === value;
        });
      if (headersMatch) return result;
      throw Errors.upstream("Evolution accepted webhook configuration but did not persist the required custom headers", {
        instanceName,
        tried: ["nested", "flat"],
        headersPersisted: false,
      });
    } catch (flatError) {
      if (flatError instanceof Error && flatError.message.includes("did not persist the required custom headers")) throw flatError;
      throw Errors.upstream("Could not configure Evolution inbound webhook headers using either supported payload shape", {
        instanceName,
        nestedAttempt: nestedError instanceof Error ? nestedError.message : (nestedError ? "request failed" : "accepted but headers were not persisted"),
        flatAttempt: flatError instanceof Error ? flatError.message : "request failed",
      });
    }
  },

  // --- Messages -----------------------------------------------------------
  sendText: (i: string, body: unknown) => evo("POST", `/message/sendText/${encodeURIComponent(i)}`, body),
  sendMedia: (i: string, body: unknown) => evo("POST", `/message/sendMedia/${encodeURIComponent(i)}`, body),
  sendButtons: (i: string, body: unknown) => evo("POST", `/message/sendButtons/${encodeURIComponent(i)}`, body),
  sendList: (i: string, body: unknown) => evo("POST", `/message/sendList/${encodeURIComponent(i)}`, body),
  sendContact: (i: string, body: unknown) => evo("POST", `/message/sendContact/${encodeURIComponent(i)}`, body),
  sendLocation: (i: string, body: unknown) => evo("POST", `/message/sendLocation/${encodeURIComponent(i)}`, body),
  sendPoll: (i: string, body: unknown) => evo("POST", `/message/sendPoll/${encodeURIComponent(i)}`, body),
  sendReaction: (i: string, body: unknown) => evo("POST", `/message/sendReaction/${encodeURIComponent(i)}`, body),
  sendTemplate: (i: string, body: unknown) => evo("POST", `/message/sendTemplate/${encodeURIComponent(i)}`, body),

  // --- Chat ---------------------------------------------------------------
  archiveChat: (i: string, body: unknown) => evo("POST", `/chat/archiveChat/${encodeURIComponent(i)}`, body),
  findChats: (i: string, body: unknown) => evo("POST", `/chat/findChats/${encodeURIComponent(i)}`, body),
  findContacts: (i: string, body: unknown) => evo("POST", `/chat/findContacts/${encodeURIComponent(i)}`, body),
  findMessages: (i: string, body: unknown) => evo("POST", `/chat/findMessages/${encodeURIComponent(i)}`, body),
  markMessageAsRead: (i: string, body: unknown) => evo("POST", `/chat/markMessageAsRead/${encodeURIComponent(i)}`, body),
  updateProfileName: (i: string, body: unknown) => evo("POST", `/chat/updateProfileName/${encodeURIComponent(i)}`, body),
  updateProfilePicture: (i: string, body: unknown) => evo("POST", `/chat/updateProfilePicture/${encodeURIComponent(i)}`, body),
  updateProfileStatus: (i: string, body: unknown) => evo("POST", `/chat/updateProfileStatus/${encodeURIComponent(i)}`, body),
  whatsappNumbers: (i: string, body: unknown) => evo("POST", `/chat/whatsappNumbers/${encodeURIComponent(i)}`, body),
  updatePresence: (i: string, body: unknown) => evo("POST", `/chat/updatePresence/${encodeURIComponent(i)}`, body),

  // --- Business -----------------------------------------------------------
  getCatalog: (i: string) => evo("GET", `/business/getCatalog/${encodeURIComponent(i)}`),
  getCollections: (i: string) => evo("GET", `/business/getCollections/${encodeURIComponent(i)}`),

  // --- Template -----------------------------------------------------------
  createTemplate: (i: string, body: unknown) => evo("POST", `/template/create/${encodeURIComponent(i)}`, body),
  editTemplate: (i: string, body: unknown) => evo("POST", `/template/edit/${encodeURIComponent(i)}`, body),
  deleteTemplate: (i: string, name: string) => evo("DELETE", `/template/delete/${encodeURIComponent(i)}/${encodeURIComponent(name)}`),
  findTemplate: (i: string) => evo("GET", `/template/find/${encodeURIComponent(i)}`),
};