import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { ZodError } from "zod";

import { config } from "./config.js";
import { ApiError, Errors } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { instanceRoutes, instanceAliasRoutes } from "./routes/instances.js";
import { messageRoutes } from "./routes/messages.js";
import { chatRoutes } from "./routes/chat.js";
import { businessRoutes } from "./routes/business.js";
import { templateRoutes } from "./routes/template.js";
import { evolutionInboundRoutes } from "./routes/evolutionInbound.js";
import { startWorker } from "./lib/webhookFanout.js";

async function build() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    },
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024, // 20MB for base64 media
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server calls
      if (config.NODE_ENV !== "production") return cb(null, true);
      const ok = config.corsOrigins.some((allowed) => origin === allowed) ||
        /^https:\/\/[a-z0-9-]+\.zailom\.com$/.test(origin);
      cb(null, ok);
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.tenant?.id ?? req.ip,
    errorResponseBuilder: () => ({
      error: { code: "rate_limited", message: "Too many requests" },
    }),
  });

  // ---- error envelope
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(422).send({
        error: { code: "validation_error", message: "Invalid request payload", details: err.flatten() },
      });
      return;
    }
    req.log.error({ err }, "unhandled error");
    reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "route_not_found", message: "Route not found" } });
  });

  // ---- routes
  await app.register(healthRoutes);
  await app.register(adminRoutes,             { prefix: "/v1/admin" });
  await app.register(instanceRoutes,          { prefix: "/v1/instances" });
  await app.register(instanceAliasRoutes,     { prefix: "/v1/instance" });
  await app.register(messageRoutes,           { prefix: "/v1/instances" });
  await app.register(chatRoutes,              { prefix: "/v1/instances" });
  await app.register(businessRoutes,          { prefix: "/v1/instances" });
  await app.register(templateRoutes,          { prefix: "/v1/instances" });
  await app.register(evolutionInboundRoutes,  { prefix: "/v1/hooks" });

  app.get("/", async () => ({
    service: "zailom-wa-service",
    version: "1.0.0",
    docs: "https://wa.zailom.com/openapi.yaml",
  }));

  return app;
}

async function main() {
  const app = await build();
  const stopWorker = startWorker();
  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    stopWorker();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: config.PORT });
  // silence unused import warning
  void Errors;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});