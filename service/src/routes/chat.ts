import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenant, requireScope } from "../middleware/auth.js";
import { evolution } from "../lib/evolution.js";
import { loadInstance } from "../lib/instanceLookup.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function chatRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);

  const proxy =
    (fn: (evoName: string, body: unknown) => Promise<unknown>, scope = "chat:write") =>
    async (req: import("fastify").FastifyRequest) => {
      const { id } = paramsSchema.parse(req.params);
      const inst = await loadInstance(req.tenant!.id, id);
      return fn(inst.evolution_instance_name, req.body ?? {});
    };

  const s = { preHandler: requireScope("chat:write") };
  const r = { preHandler: requireScope("chat:read") };

  app.post("/:id/chat/archiveChat",         s, proxy(evolution.archiveChat));
  app.post("/:id/chat/findChats",           r, proxy(evolution.findChats));
  app.post("/:id/chat/findContacts",        r, proxy(evolution.findContacts));
  app.post("/:id/chat/findMessages",        r, proxy(evolution.findMessages));
  app.post("/:id/chat/markMessageAsRead",   s, proxy(evolution.markMessageAsRead));
  app.post("/:id/chat/updateProfileName",   s, proxy(evolution.updateProfileName));
  app.post("/:id/chat/updateProfilePicture",s, proxy(evolution.updateProfilePicture));
  app.post("/:id/chat/updateProfileStatus", s, proxy(evolution.updateProfileStatus));
  app.post("/:id/chat/whatsappNumbers",     r, proxy(evolution.whatsappNumbers));
}