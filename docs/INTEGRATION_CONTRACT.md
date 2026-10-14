# Zailom integration contract: Booking, Flow, wa-service and Evolution

## Ownership and traffic

```text
Zailom Booking ─┐
               ├── HTTPS + tenant API key ──> wa-service (this repository) ──> Evolution API
Zailom Flow ───┘                                  │                           │
                                                  │<── per-instance webhook ──┘
                                                  └── tenant webhook fan-out (optional)
```

- **Booking and Flow are clients.** They call the wa-service; neither product should call Evolution directly for instance lifecycle, QR, messages, bot settings, or webhook configuration.
- **wa-service is the integration boundary.** It owns tenant/API-key authentication, the mapping between a product tenant and Evolution instance, normalization of Evolution's version-specific payloads, inbound webhook validation, and state synchronization.
- **Evolution is the WhatsApp transport.** The global Evolution API key is server-side only and is used by wa-service for Evolution REST calls.
- **Shared Booking/Flow account:** an embedded Flow workspace must resolve to the same Booking tenant (`product=booking`, `product_tenant_id=<company id>`). This is what makes the same instance list visible from both products. A standalone Flow workspace uses `product=flow`, `product_tenant_id=<workspace id>`.

## Client authentication

Clients call wa-service with `Authorization: Bearer <zwa_live_...>` (or `X-Api-Key`). The API key belongs to the resolved wa-service tenant and its scopes must authorize the requested operation. The admin token is only for server-side tenant/key provisioning and must never be exposed to the browser.

## Instance creation and webhook authentication

1. wa-service creates the Evolution instance using the server-side global Evolution API key.
2. The individual Evolution instance API key returned by Evolution is persisted as `instances.evolution_token`. It is a secret and must never be returned to Booking, Flow, or the browser.
3. wa-service configures the instance's inbound webhook to:
   `{PUBLIC_BASE_URL}/v1/hooks/evolution/{url-encoded-evolution-instance-name}`
4. Every Evolution webhook delivery must include `X-Evolution-Token: <that instance's evolution_token>`.
5. The inbound endpoint compares that header with the key stored for the exact Evolution instance before accepting the event. `EVOLUTION_INBOUND_TOKEN` is legacy fallback only for records that have no per-instance key; it is not a substitute for the required per-instance header when the key exists.
6. The receiver updates connection/QR state and optionally fans the event out to the tenant's configured webhook URL.

## Evolution webhook payload compatibility

Evolution v2 deployments differ in their webhook/set request envelope. wa-service must configure the webhook using the supported payload shape and verify the saved configuration with Evolution's webhook/find endpoint. A successful HTTP response alone is not proof that custom headers were persisted. Compatibility logic must not log or return the actual instance token.

## Shared-instance invariants

- An instance created from Booking and an instance created from its embedded Flow must resolve to the same wa-service tenant and therefore the same `instances` rows.
- Instance names are Evolution identifiers; the wa-service UUID is the public instance identifier for client routes such as `POST /v1/instances/{id}/connect`.
- State transitions from Evolution webhooks and explicit refresh operations must update the same wa-service row, so both clients see the same status.
- Deleting an instance is a wa-service operation. Clients must not independently delete the corresponding Evolution instance behind the service's back.

## Current repair endpoint

For a previously created instance, an authenticated client with `instances:write` can call:

`POST /v1/instances/{wa-service-instance-uuid}/webhook/sync-inbound`

This re-applies the canonical inbound URL and per-instance `X-Evolution-Token` header. It does not create a new instance or rotate the Evolution key. If the key was never saved for an existing instance, the service must report that as a specific repair failure rather than silently accepting an unauthenticated webhook.

## Operational checks

- Evolution `webhook/find/{instanceName}`: verify URL, enabled state, events, and that `headers` contains `X-Evolution-Token` (never print its value in shared logs).
- wa-service inbound logs: distinguish unknown instance, missing/invalid token, and processing errors.
- A webhook 401 is an authentication/configuration failure; it is not a bot prompt or Flow runtime issue.
