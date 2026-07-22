# zailom-wa-service

Serviço central que unifica o uso da **Evolution API** entre todos os produtos
Zailom (Booking, Flow, e o que vier depois). É a **única** fonte de verdade
para instâncias WhatsApp: nenhum produto cliente deve mais falar direto com
`api-evo.zailom.com`.

- **Runtime:** Node 20 + Fastify + TypeScript strict
- **Banco:** projeto Supabase externo dedicado (`bcouunitysjtsjvwulnh`), acesso
  direto via Postgres (connection string). RLS ativa como defesa em
  profundidade.
- **Auth:** API key por tenant (Argon2id), Bearer.
- **Webhooks:** fan-out persistido com HMAC-SHA256 e backoff exponencial.
- **Deploy:** Docker → Portainer stack → Traefik → `https://wa.zailom.com`

---

## 📁 Layout

```
service/
├── src/
│   ├── server.ts              # bootstrap Fastify
│   ├── config.ts              # envs validadas com Zod
│   ├── db.ts                  # pool pg
│   ├── errors.ts              # ApiError + envelope padrão
│   ├── middleware/auth.ts     # requireTenant / requireAdmin / requireScope
│   ├── lib/
│   │   ├── apiKeys.ts         # gerar / hash / verify
│   │   ├── evolution.ts       # cliente HTTP Evolution v2
│   │   ├── webhookFanout.ts   # persistência + retry + HMAC
│   │   ├── audit.ts
│   │   ├── instanceLookup.ts
│   │   └── instanceName.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── admin.ts           # POST/GET /v1/admin/tenants + api-keys
│   │   ├── instances.ts       # CRUD + connect + settings + webhook config
│   │   ├── messages.ts        # sendText/Media/Buttons/List/…
│   │   ├── chat.ts
│   │   ├── business.ts
│   │   ├── template.ts
│   │   └── evolutionInbound.ts  # POST /v1/hooks/evolution/:evoName
│   └── types/fastify.d.ts
├── migrations/001_init.sql
├── openapi.yaml
├── INTEGRATION-GUIDE.md
├── Dockerfile
├── docker-compose.yml
├── package.json / tsconfig.json / .env.example
```

---

## 🔑 Variáveis de ambiente

Ver `.env.example`. Resumão:

| Var                          | Onde obter                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `SUPABASE_URL`               | Supabase Dashboard → **Project Settings → Data API** → *Project URL*                    |
| `SUPABASE_SERVICE_ROLE_KEY`  | Supabase Dashboard → **Project Settings → API Keys** → *service_role* (secret)          |
| `DATABASE_URL`               | Supabase Dashboard → **Project Settings → Database** → *Connection string (Session, 5432)* — troque `[YOUR-PASSWORD]` pela senha do DB (definida no primeiro acesso ou resetável na mesma tela) |
| `EVOLUTION_GLOBAL_API_KEY`   | env `AUTHENTICATION_API_KEY` da sua stack Evolution (`api-evo.zailom.com`)              |
| `EVOLUTION_INBOUND_TOKEN`    | opcional. Se definido, Evolution precisa enviar `X-Evolution-Token: <valor>` de volta   |
| `ADMIN_TOKEN`                | gere com `openssl rand -hex 32`                                                         |
| `WEBHOOK_SIGNING_SECRET`     | gere com `openssl rand -hex 32`. **Compartilhe com Booking/Flow** — eles precisam pra verificar o HMAC |
| `PUBLIC_BASE_URL`            | `https://wa.zailom.com`                                                                 |
| `CORS_ORIGINS`               | csv de origens permitidas (regex `*.zailom.com` já é whitelisted em prod)               |
| `RATE_LIMIT_MAX/WINDOW_MS`   | rate limit por tenant                                                                   |

> **Nunca** exponha `EVOLUTION_GLOBAL_API_KEY` para Booking/Flow. Eles só devem
> conhecer a API key deles + o `WEBHOOK_SIGNING_SECRET`.

---

## 🏗 Setup local

```bash
cd service
cp .env.example .env      # preencher DATABASE_URL, SUPABASE_*, EVOLUTION_GLOBAL_API_KEY, tokens
npm install
npm run dev               # http://localhost:8080
```

Rodar as migrations no Supabase:

1. Abra o Supabase Dashboard → **SQL Editor** → **New query**.
2. Cole o conteúdo de `migrations/001_init.sql` e rode.
3. Confirme em **Table Editor** que existem `tenants`, `api_keys`, `instances`,
   `audit_log`, `webhook_deliveries` e que a coluna *RLS enabled* está ✓.

---

## 🐳 Deploy (Portainer)

A rede `wa-api-service` já existe no seu Portainer e o Traefik já está anexado
a ela — o `docker-compose.yml` referencia essa rede como `external: true`.

1. **Publique a imagem** num registry (recomendado):
   - CI faz `docker build -t ghcr.io/SEUORG/zailom-wa-service:<tag>` e push.
   - Edite `docker-compose.yml` trocando o bloco `build:` por `image: ghcr.io/...`.
2. **Portainer → Stacks → Add stack**:
   - cole `docker-compose.yml`
   - preencha as **Stack env** com os valores da tabela acima
   - deploy
3. Confira `https://wa.zailom.com/healthz` → `{ ok: true }`.
4. Confira `https://wa.zailom.com/readyz` → `{ ok: true }` (DB alcançável).

> Se preferir build no host do Portainer, deixe o `build:` como está e faça
> upload da pasta do repo via **Web editor + Upload**. Em produção, imagem em
> registry escala melhor.

---

## 🔄 Fluxo de webhooks

```
WhatsApp ──▶ Evolution ──▶ (nossa URL: /v1/hooks/evolution/:evoName)
                            │
                            │ 1. atualiza status/QR local
                            │ 2. enqueue delivery em webhook_deliveries
                            ▼
                     worker interno (a cada 2s)
                            │
                            │ POST assinado com HMAC
                            ▼
                Booking / Flow (webhook_url do tenant)
```

---

## 📚 Docs

- **`INTEGRATION-GUIDE.md`** — leia isso primeiro se você é o dev do Booking/Flow.
- **`openapi.yaml`** — contrato completo. Cole em https://editor.swagger.io/ pra explorar.

---

## 🧪 Smoke test após deploy

```bash
API=https://wa.zailom.com
ADMIN=<seu ADMIN_TOKEN>

# 1. cria um tenant de teste
TENANT_ID=$(curl -s -X POST $API/v1/admin/tenants \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"product":"other","product_tenant_id":"smoke-1","name":"smoke test"}' | jq -r .id)

# 2. emite key
KEY=$(curl -s -X POST $API/v1/admin/api-keys \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT_ID\",\"name\":\"smoke\"}" | jq -r .api_key)

# 3. cria instância (isso já bate na Evolution)
curl -s -X POST $API/v1/instances/create \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"smoke-inst"}' | jq
```

Se a resposta traz `qr_code`, o pipeline inteiro está funcionando: banco →
Evolution → registro local → resposta. 🎉

---

## 🔒 Segurança

- API keys nunca em texto plano (Argon2id).
- RLS ativa em todas as tabelas (`FORCE ROW LEVEL SECURITY`) com `REVOKE` para
  `anon`/`authenticated` — se alguém encontrar a URL do Supabase e uma
  publishable key, ainda não vê nada.
- CORS restrito a `*.zailom.com` em produção.
- Rate limit por tenant.
- Signature HMAC-SHA256 em toda entrega de webhook.
- Global API key da Evolution jamais retornada para o cliente.

---

## ✅ Checklist "eu terminei"

- [ ] `migrations/001_init.sql` rodado no Supabase novo.
- [ ] Vars preenchidas na stack Portainer.
- [ ] `https://wa.zailom.com/healthz` responde 200.
- [ ] `https://wa.zailom.com/readyz` responde 200.
- [ ] `POST /v1/admin/tenants` cria um tenant sem erro.
- [ ] `POST /v1/admin/api-keys` retorna uma `api_key` no formato `zwa_live_..._...`.
- [ ] `POST /v1/instances/create` com essa key retorna `qr_code` base64.
- [ ] Escaneou o QR num WhatsApp → status vai pra `connected` em <10s (via
      webhook `CONNECTION_UPDATE`).
- [ ] `POST /v1/instances/:id/message/sendText` entrega uma mensagem real.
- [ ] Webhook do tenant recebe pelo menos um evento com header
      `X-Zailom-Signature` válido.