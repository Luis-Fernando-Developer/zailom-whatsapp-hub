# zailom-wa-service — Integration Guide

Guia para o dev que vai integrar Booking, Flow (ou qualquer outro produto Zailom)
com o serviço central de WhatsApp/Evolution.

> **TL;DR** — pare de falar com a Evolution direto. Fale com `https://wa.zailom.com`
> usando a API key do seu tenant, e receba eventos via webhook assinado com HMAC.

---

## 1. Conceitos

- **Tenant**: representa um "cliente" do seu produto (uma `company` no Booking, um
  `workspace` no Flow). Cada tenant tem 1..N instâncias de WhatsApp.
- **Instance**: uma sessão WhatsApp real (equivalente a uma "instância" Evolution).
  Cada instância pertence a exatamente um tenant.
- **API key**: string opaca (`zwa_live_<prefix>_<secret>`) que autentica um tenant.
  O prefixo é indexável; o segredo é hashado com Argon2id. É mostrada **uma única
  vez**, no momento da criação.

O serviço é a fonte única de verdade: **nunca chame `api-evo.zailom.com` direto**.
A GLOBAL API KEY da Evolution mora só dentro do serviço.

---

## 2. Bootstrap (uma vez por produto)

Você (ops/dev do Booking ou Flow) usa o **Admin API** para criar o tenant e emitir
a API key. O Admin API é protegido pelo header `X-Admin-Token: $ADMIN_TOKEN`.

### 2.1. Criar o tenant

```bash
curl -X POST https://wa.zailom.com/v1/admin/tenants \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "booking",
    "product_tenant_id": "company_abc123",
    "name": "Salão da Ana"
  }'
# → 201 { "id": "018f...-uuid", "product": "booking", ... }
```

Guarde o `id` retornado — é o `tenant_id` interno do serviço.

> Você pode chamar esse endpoint sempre que criar uma company no Booking / workspace
> no Flow: ele é idempotente na chave `(product, product_tenant_id)`.

### 2.2. Emitir a API key

```bash
curl -X POST https://wa.zailom.com/v1/admin/api-keys \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "tenant_id": "018f...-uuid", "name": "booking-prod-key" }'
# → 201 {
#     "api_key": "zwa_live_a1b2c3d4e5f6_...40hex...",
#     "warning": "This key will NOT be shown again."
#   }
```

**Salve o `api_key` no gerenciador de segredos do seu produto imediatamente.**
O serviço só guarda o hash — se você perder, tem que revogar e emitir outra.

### 2.3. Revogar

```bash
curl -X DELETE https://wa.zailom.com/v1/admin/api-keys/{key_id} \
  -H "X-Admin-Token: $ADMIN_TOKEN"
# → 204
```

---

## 3. Autenticação normal (Booking/Flow → wa-service)

Todo endpoint fora de `/v1/admin/*` e `/v1/hooks/*` exige:

```
Authorization: Bearer zwa_live_<prefix>_<secret>
```

(também aceita `X-Api-Key: <chave>` como alternativa)

O serviço resolve `tenant_id` sozinho a partir da key — você **nunca** envia
`tenant_id` nas requisições normais. Isso garante isolamento estrito.

---

## 4. Fluxo típico: criar → conectar → enviar

```bash
API=https://wa.zailom.com
KEY=zwa_live_a1b2c3d4e5f6_...

# 4.1 criar a instância (Evolution + registro local, em uma chamada)
INSTANCE=$(curl -s -X POST $API/v1/instances/create \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "atendimento-1",
    "webhook_url": "https://booking.zailom.com/api/webhooks/wa",
    "webhook_events": ["MESSAGES_UPSERT","CONNECTION_UPDATE"]
  }')
echo $INSTANCE
# → { "id": "018f...-uuid", "qr_code": "data:image/png;base64,...", "status": "connecting" }

ID=$(echo $INSTANCE | jq -r .id)

# 4.2 mostrar o QR na sua UI (o data URI já é o base64 pronto pra <img src>)

# 4.3 se o QR expirou (~60s), pega outro:
curl -X POST $API/v1/instances/$ID/connect \
  -H "Authorization: Bearer $KEY"

# 4.4 polling opcional (ou espere o webhook CONNECTION_UPDATE)
curl $API/v1/instance/connectionState/$ID -H "Authorization: Bearer $KEY"

# 4.5 sincroniza status local com o que a Evolution diz
curl -X POST $API/v1/instances/$ID/refresh-status -H "Authorization: Bearer $KEY"

# 4.6 enviar uma mensagem
curl -X POST $API/v1/instances/$ID/message/sendText \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "number": "5511999999999", "text": "Olá do Zailom!" }'
```

---

## 5. Webhooks recebidos (wa-service → Booking/Flow)

Quando você configura `webhook_url` na criação (ou depois via `POST
/v1/instances/:id/webhook/set`), o serviço reenvia **todos** os eventos que a
Evolution manda para essa instância.

### 5.1. Formato

```
POST https://booking.zailom.com/api/webhooks/wa

Headers:
  Content-Type:            application/json
  X-Zailom-Event:          MESSAGES_UPSERT
  X-Zailom-Delivery-Id:    018f...-uuid
  X-Zailom-Signature:      sha256=<hex>
```

```json
{
  "event": "MESSAGES_UPSERT",
  "timestamp": "2026-07-22T14:33:12.123Z",
  "data": {
    "instance_id": "018f...-uuid",
    "evolution_instance_name": "booking-abc12345-atendimento-1-9f2a",
    "event": "MESSAGES_UPSERT",
    "data": { /* payload cru da Evolution */ }
  }
}
```

O campo `data.data` é o payload cru que a Evolution enviou (útil para debug).
O campo `data.instance_id` é a nossa PK — use ela para saber a qual conexão o
evento pertence.

### 5.2. Verificação HMAC (obrigatória!)

O header `X-Zailom-Signature` é `sha256=<hex(HMAC-SHA256(body, WEBHOOK_SIGNING_SECRET))>`.

**Node.js:**

```ts
import crypto from "node:crypto";

function verify(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

> **Cuidado:** compare no **corpo cru** (`Buffer`), antes de qualquer
> desserialização/reordenação de JSON.

### 5.3. Retries e idempotência

- O worker interno retenta em: **1s, 5s, 30s, 5min, 30min, 2h**.
- Depois de 6 tentativas falhas o registro vira `dead` (fica na tabela pra
  análise, mas não é mais entregue).
- **Trate seu handler como idempotente.** Use `X-Zailom-Delivery-Id` como chave.
- Responda **HTTP 2xx** dentro de 15s para o serviço marcar como entregue.
  Qualquer 4xx/5xx vira retry.

### 5.4. Filtro de eventos

Se `webhook_events` estiver vazio, TODOS os eventos são reenviados.
Se for uma lista, só eventos com `event` naquela lista são entregues.

---

## 6. Códigos de erro (padrão)

Todos os erros retornam este envelope:

```json
{ "error": { "code": "instance_not_found", "message": "instance not found", "details": null } }
```

| HTTP | code                       | Quando acontece                                          | O que fazer                  |
| ---- | -------------------------- | -------------------------------------------------------- | ---------------------------- |
| 401  | `unauthorized`             | header ausente, key malformada, revogada ou inválida     | Reautenticar / rotacionar    |
| 403  | `forbidden`                | API key sem o scope necessário                           | Emitir key com scope         |
| 404  | `instance_not_found`       | ID não existe ou pertence a outro tenant                 | Não repita                   |
| 404  | `tenant_not_found`         | admin op referenciou tenant inexistente                  | Verificar                    |
| 404  | `route_not_found`          | URL errada                                               | Ver OpenAPI                  |
| 409  | `conflict`                 | conflito de estado (ex: nome já existe)                  | Renomear                     |
| 422  | `validation_error`         | payload inválido; `details` traz o breakdown             | Corrigir payload             |
| 429  | `rate_limited`             | passou o limite (padrão 300 req/min/tenant)              | Backoff exponencial          |
| 500  | `internal_error`           | bug nosso                                                | Reportar (delivery_id)       |
| 502  | `evolution_upstream_error` | a Evolution rejeitou; `details.body` traz a resposta     | Verificar payload/número     |

---

## 7. Scopes disponíveis

Quando você emite a API key, pode restringir os scopes. Padrão: tudo liberado.

| Scope             | Endpoints                                    |
| ----------------- | -------------------------------------------- |
| `instances:read`  | GET all-instances, GET :id, connectionState  |
| `instances:write` | create, connect, restart, logout, delete     |
| `messages:send`   | todos `POST /message/*`                      |
| `chat:read`       | findChats, findContacts, findMessages, ...   |
| `chat:write`      | archive, markRead, updateProfile*, ...       |
| `business:read`   | getCatalog, getCollections                   |
| `template:read`   | template/find                                |
| `template:write`  | template/create, edit, delete                |
| `webhooks:read`   | GET /webhook/find                            |
| `webhooks:write`  | POST /webhook/set                            |
| `<group>:*`       | wildcard para todo o grupo                   |
| `admin`           | wildcard geral (evite emitir)                |

---

## 8. Exemplos rápidos (curl)

```bash
# listar instâncias
curl $API/v1/instances/all-instances -H "Authorization: Bearer $KEY"

# enviar mídia por URL
curl -X POST $API/v1/instances/$ID/message/sendMedia \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "number": "5511999999999", "mediatype": "image",
        "media": "https://cdn.zailom.com/logo.png", "caption": "olá" }'

# checar se um número tem WhatsApp
curl -X POST $API/v1/instances/$ID/chat/whatsappNumbers \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "numbers": ["5511999999999","5511888888888"] }'

# desligar
curl -X POST $API/v1/instances/$ID/logout -H "Authorization: Bearer $KEY"

# deletar de vez
curl -X DELETE $API/v1/instances/$ID/delete -H "Authorization: Bearer $KEY"
```

---

## 9. Boas práticas

- **Never** log the API key or the WEBHOOK_SIGNING_SECRET.
- Use **HTTPS** for `webhook_url` — o serviço não impede HTTP mas você quer TLS.
- Faça o handler de webhook **rápido (≤ 500 ms)**. Faça o trabalho pesado em
  fila interna sua.
- Trate 502 `evolution_upstream_error` como transiente e faça backoff — a
  Evolution às vezes tem picos.
- Assuma que a mesma delivery pode chegar 2x. Idempotência é sua amiga.