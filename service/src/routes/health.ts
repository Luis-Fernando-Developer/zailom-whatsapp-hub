import type { FastifyInstance } from "fastify";
import { query } from "../db.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true, service: "zailom-wa-service", ts: new Date().toISOString() }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await query("SELECT 1");
      return { ok: true };
    } catch (err) {
      reply.code(503);
      return { ok: false, error: (err as Error).message };
    }
  });
}