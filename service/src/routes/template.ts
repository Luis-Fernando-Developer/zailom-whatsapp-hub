import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenant, requireScope } from "../middleware/auth.js";
import { evolution } from "../lib/evolution.js";
import { loadInstance } from "../lib/instanceLookup.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function templateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);

  app.post("/:id/template/create", { preHandler: requireScope("template:write") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.createTemplate(inst.evolution_instance_name, req.body ?? {});
  });

  app.post("/:id/template/edit", { preHandler: requireScope("template:write") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.editTemplate(inst.evolution_instance_name, req.body ?? {});
  });

  app.delete("/:id/template/delete", { preHandler: requireScope("template:write") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const body = z.object({ name: z.string().min(1) }).parse(req.body ?? {});
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.deleteTemplate(inst.evolution_instance_name, body.name);
  });

  app.get("/:id/template/find", { preHandler: requireScope("template:read") }, async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const inst = await loadInstance(req.tenant!.id, id);
    return evolution.findTemplate(inst.evolution_instance_name);
  });
}