/**
 * Standardised error envelope returned to clients.
 *  { "error": { "code": "instance_not_found", "message": "...", "details": {...} } }
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (msg = "Missing or invalid API key") => new ApiError(401, "unauthorized", msg),
  forbidden: (msg = "Insufficient scope") => new ApiError(403, "forbidden", msg),
  notFound: (resource: string) => new ApiError(404, `${resource}_not_found`, `${resource} not found`),
  conflict: (msg: string) => new ApiError(409, "conflict", msg),
  validation: (msg: string, details?: unknown) => new ApiError(422, "validation_error", msg, details),
  rateLimited: () => new ApiError(429, "rate_limited", "Too many requests"),
  upstream: (msg: string, details?: unknown) => new ApiError(502, "evolution_upstream_error", msg, details),
  internal: (msg = "Internal server error") => new ApiError(500, "internal_error", msg),
};