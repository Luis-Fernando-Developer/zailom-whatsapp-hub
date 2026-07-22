import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenant, requireScope } from "../middleware/auth.js";
import { evolution } from "../lib/evolution.js";
import { loadInstance } from "../lib/instanceLookup.js";
import { audit } from "../lib/audit.js";

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * Messages are proxied to Evolution with minimal reshaping. The service:
 *   - resolves the instance
 *   - injects the correct evolution_instance_name
 *   - forwards the body untouched (Evolution's schema is the source of truth)
 *   - audits the send
 */
export async function messageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireTenant);

  const proxy =
    (
      action: string,
      fn: (evoName: string, body: unknown) => Promise<unknown>,
    ) =>
    async (req: import("fastify").FastifyRequest) => {
      const { id } = paramsSchema.parse(req.params);
      const inst = await loadInstance(req.tenant!.id, id);
      const res = await fn(inst.evolution_instance_name, req.body ?? {});
      await audit({
        tenantId: req.tenant!.id,
        actor: `api_key:${req.tenant!.apiKeyId}`,
        action: `message.${action}`,
        resourceType: "instance",
        resourceId: id,
      });
      return res;
    };

  const scope = { preHandler: requireScope("messages:send") };

  app.post("/:id/message/sendText",     scope, proxy("sendText",     evolution.sendText));
  app.post("/:id/message/sendMedia",    scope, proxy("sendMedia",    evolution.sendMedia));
  app.post("/:id/message/sendButtons",  scope, proxy("sendButtons",  evolution.sendButtons));
  app.post("/:id/message/sendList",     scope, proxy("sendList",     evolution.sendList));
  app.post("/:id/message/sendContact",  scope, proxy("sendContact",  evolution.sendContact));
  app.post("/:id/message/sendLocation", scope, proxy("sendLocation", evolution.sendLocation));
  app.post("/:id/message/sendPoll",     scope, proxy("sendPoll",     evolution.sendPoll));
  app.post("/:id/message/sendReaction", scope, proxy("sendReaction", evolution.sendReaction));
  app.post("/:id/message/sendTemplate", scope, proxy("sendTemplate", evolution.sendTemplate));
}