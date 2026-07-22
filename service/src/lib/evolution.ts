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
    webhook?: { url: string; byEvents?: boolean; base64?: boolean; events?: string[] };
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
  setWebhook: (instanceName: string, body: Record<string, unknown>) =>
    evo("POST", `/webhook/set/${encodeURIComponent(instanceName)}`, body),

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

  // --- Business -----------------------------------------------------------
  getCatalog: (i: string) => evo("GET", `/business/getCatalog/${encodeURIComponent(i)}`),
  getCollections: (i: string) => evo("GET", `/business/getCollections/${encodeURIComponent(i)}`),

  // --- Template -----------------------------------------------------------
  createTemplate: (i: string, body: unknown) => evo("POST", `/template/create/${encodeURIComponent(i)}`, body),
  editTemplate: (i: string, body: unknown) => evo("POST", `/template/edit/${encodeURIComponent(i)}`, body),
  deleteTemplate: (i: string, name: string) => evo("DELETE", `/template/delete/${encodeURIComponent(i)}/${encodeURIComponent(name)}`),
  findTemplate: (i: string) => evo("GET", `/template/find/${encodeURIComponent(i)}`),
};