import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenant, requireScope } from "../middleware/auth.js";
import { evolution } from "../lib/evolution.js";
import { loadInstance } from "../lib/instanceLookup.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function businessRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);

  app.get("/:id/business/getCatalog", { preHandler: requireScope("business:read") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.getCatalog(inst.evolution_instance_name);
  });

  app.get("/:id/business/getCollections", { preHandler: requireScope("business:read") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.getCollections(inst.evolution_instance_name);
  });
}