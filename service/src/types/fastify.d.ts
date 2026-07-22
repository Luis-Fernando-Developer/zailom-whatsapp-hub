import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: {
      id: string;
      product: "booking" | "flow" | "other";
      name: string;
      apiKeyId: string;
      scopes: string[];
    };
  }
}